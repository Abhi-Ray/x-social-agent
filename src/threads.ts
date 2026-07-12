import type { Page } from "playwright";
import type { ContextWindow, ThreadPostResult } from "./types";
import { buildSystemPrompt, buildContextSection } from "./persona";
import { getFreeModels } from "./openrouter";
import { checkForChallenge } from "./session";
import { sleep } from "./config";

function cleanContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let cleaned = raw.trim();
  if (!cleaned) throw new Error("Model response was empty");
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model response did not contain a JSON object");
  const jsonStr = cleaned.slice(start, end + 1);
  try {
    const value: unknown = JSON.parse(jsonStr);
    if (!isRecord(value)) throw new Error("Model response was not an object");
    return value;
  } catch {
    try {
      const fixed = jsonStr
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
      const value: unknown = JSON.parse(fixed);
      if (!isRecord(value)) throw new Error("Model response was not an object");
      return value;
    } catch {
      throw new Error(`JSON parse failed. Content (first 200 chars): ${jsonStr.slice(0, 200)}`);
    }
  }
}

function validateThread(raw: unknown): string[] {
  if (!isRecord(raw)) throw new Error("Thread response was not an object");
  const tweets = raw.tweets;
  if (!Array.isArray(tweets)) throw new Error("Missing tweets array");
  if (tweets.length < 3 || tweets.length > 5) throw new Error(`Thread must be 3-5 tweets, got ${tweets.length}`);
  return tweets.map((tweet, i) => {
    if (typeof tweet !== "string") throw new Error(`Tweet ${i + 1} is not a string`);
    const trimmed = tweet.trim();
    if (!trimmed) throw new Error(`Tweet ${i + 1} is empty`);
    if (trimmed.length > 280) throw new Error(`Tweet ${i + 1} exceeds 280 chars (${trimmed.length})`);
    return trimmed;
  });
}

export async function generateThread(
  apiKey: string,
  context: ContextWindow,
  topic: string,
): Promise<string[]> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = buildSystemPrompt();
  const contextSection = buildContextSection(context);

  const userPrompt = `Generate a punchy 3-5 tweet thread on this topic: "${topic}"

${contextSection}

Return ONLY a JSON object with this exact shape:
{"tweets":["tweet 1 text","tweet 2 text","tweet 3 text"]}

Rules:
- 3-5 tweets. No more, no less.
- First tweet is the HOOK. It must stop the scroll. Pattern interrupt, bold claim, or a question that baits replies.
- Subsequent tweets expand on the hook. One idea per tweet. Build momentum.
- Each tweet MUST be under 280 characters. SHORTER IS BETTER.
- WRITE SIMPLE. A 12-year-old should understand every tweet. No big words. No long sentences.
- Be funny, sarcastic, opinionated. No corporate bot energy.
- No hashtag spam (0-1 max, only if it's the joke).
- No emoji spam (1 max, only if it's the punchline).
- Do NOT repeat topics or angles from recent posts shown in context.
- End the thread with a take or a question that makes people want to reply.`;

  const errors: string[] = [];
  for (const model of models) {
    console.log(`[Threads] Using model: ${model}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "http-referer": "https://github.com/Abhi-Ray/x-social-agent",
          "x-title": "X Social Agent",
        },
        body: JSON.stringify({
          model,
          temperature: 0.5,
          max_tokens: 4000,
          reasoning: { effort: "none" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: attempt === 0
                ? userPrompt
                : `${userPrompt}\nYour prior response failed validation. Return ONLY the exact JSON shape requested. No thinking, no reasoning, no explanation. Start with { and end with }.`,
            },
          ],
        }),
      });

      if (response.status === 402 || response.status === 429 || response.status >= 500) {
        errors.push(`${model}: HTTP ${response.status}`);
        break;
      }
      if (!response.ok) {
        errors.push(`${model}: HTTP ${response.status}`);
        break;
      }

      let body: { choices?: Array<{ message?: { content?: string } }> };
      try {
        body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      } catch {
        errors.push(`${model}: invalid API response`);
        break;
      }

      let content = body.choices?.[0]?.message?.content;
      if (content) content = cleanContent(content);
      if (!content) {
        errors.push(`${model}: empty response`);
        continue;
      }

      try {
        const parsed = parseJsonObject(content);
        return validateThread(parsed);
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "validation failed"} (content: ${content.slice(0, 200)})`);
      }
    }
  }
  throw new Error(`All free OpenRouter models failed for thread generation: ${errors.slice(-6).join("; ")}`);
}

export async function postThread(page: Page, tweets: string[]): Promise<ThreadPostResult> {
  if (!tweets.length) {
    return { success: false, threadUrl: null, error: "No tweets provided" };
  }

  try {
    // Post the first tweet (the hook)
    await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 30_000 });

    if (await checkForChallenge(page)) {
      return { success: false, threadUrl: null, error: "Challenge page detected" };
    }

    try {
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
    } catch {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
    }

    const firstTweet = tweets[0];
    if (!firstTweet) {
      return { success: false, threadUrl: null, error: "First tweet is missing" };
    }

    await page.click('[data-testid="tweetTextarea_0"]');
    await page.fill('[data-testid="tweetTextarea_0"]', firstTweet);
    await sleep(500 + Math.random() * 1000);

    await page.click('[data-testid="tweetButton"]');
    await sleep(2000 + Math.random() * 2000);

    if (await checkForChallenge(page)) {
      return { success: false, threadUrl: null, error: "Challenge page detected after first tweet" };
    }

    const threadUrl = await captureLatestTweetUrl(page);

    // Post subsequent tweets as replies to the previous tweet
    let previousTweetUrl = threadUrl;
    for (let i = 1; i < tweets.length; i++) {
      if (!previousTweetUrl) {
        return { success: false, threadUrl: null, error: `Could not determine URL of tweet ${i} to reply to` };
      }

      await page.goto(previousTweetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      if (await checkForChallenge(page)) {
        return { success: false, threadUrl, error: `Challenge page detected before posting tweet ${i + 1}` };
      }

      try {
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
      } catch {
        return { success: false, threadUrl, error: `Reply box not found for tweet ${i + 1}` };
      }

      const tweetText = tweets[i];
      if (!tweetText) {
        return { success: false, threadUrl, error: `Tweet ${i + 1} is missing` };
      }

      await page.click('[data-testid="tweetTextarea_0"]');
      await page.fill('[data-testid="tweetTextarea_0"]', tweetText);
      await sleep(500 + Math.random() * 1000);

      await page.click('[data-testid="tweetButtonInline"]');
      await sleep(2000 + Math.random() * 2000);

      if (await checkForChallenge(page)) {
        return { success: false, threadUrl, error: `Challenge page detected after posting tweet ${i + 1}` };
      }

      // Capture the URL of the reply for the next iteration
      const replyUrl = await captureLatestTweetUrl(page);
      if (replyUrl) previousTweetUrl = replyUrl;
    }

    return { success: true, threadUrl, error: null };
  } catch (error) {
    const isChallenge = await checkForChallenge(page);
    return {
      success: false,
      threadUrl: null,
      error: isChallenge
        ? "Challenge page detected"
        : error instanceof Error ? error.message : String(error),
    };
  }
}

async function captureLatestTweetUrl(page: Page): Promise<string | null> {
  try {
    const toast = await page.$('[data-testid="toast"]');
    if (toast) {
      const link = await toast.$("a[href]");
      if (link) {
        const href = await link.getAttribute("href");
        if (href) return href.startsWith("http") ? href : `https://x.com${href}`;
      }
    }
  } catch {
    // Ignore — URL capture is best-effort
  }
  return null;
}
