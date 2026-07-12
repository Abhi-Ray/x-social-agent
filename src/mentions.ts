import type { Page } from "playwright";
import { checkForChallenge } from "./session";
import { buildSystemPrompt } from "./persona";
import { getFreeModels } from "./openrouter";
import type { SupabaseClient } from "./supabase";
import type { ScrapedMention } from "./types";

export async function scrapeMentions(page: Page, ownHandle: string): Promise<ScrapedMention[]> {
  const mentionsUrl = "https://x.com/notifications/mentions";
  await page.goto(mentionsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge during mentions scrape. Stopping.");
  }

  const mentions: ScrapedMention[] = [];
  try {
    await page.waitForSelector('article [data-testid="tweetText"]', { timeout: 15_000 });
  } catch {
    return mentions;
  }

  const articles = await page.$$('article').catch(() => []);
  for (const article of articles) {
    const text = await article.$eval('[data-testid="tweetText"]', (el) => el.textContent ?? "").catch(() => "");
    if (!text) continue;

    const authorHandle = await article.$eval('a[href^="/"]', (el) => {
      const href = el.getAttribute("href") ?? "";
      return href.replace("/", "");
    }).catch(() => "");
    const authorName = await article.$eval('a[role="link"] [tabindex], a[role="link"] span', (el) => el.textContent ?? "").catch(() => "");

    const url = await article.$eval("time", (el) => {
      const link = el.parentElement;
      return link?.getAttribute("href") ?? "";
    }).catch(() => "");

    if (!text.toLowerCase().includes(`@${ownHandle.toLowerCase()}`)) continue;
    if (!url) continue;

    mentions.push({
      authorHandle: String(authorHandle),
      authorName: String(authorName).trim(),
      tweetUrl: url.startsWith("http") ? url : `https://x.com${url}`,
      tweetText: text.trim(),
    });
  }

  const seen = new Set<string>();
  return mentions.filter((m) => {
    if (seen.has(m.tweetUrl)) return false;
    seen.add(m.tweetUrl);
    return true;
  });
}

export async function generateReplyToMention(apiKey: string, mentionText: string, authorHandle: string): Promise<string> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = `Someone just mentioned you on X/Twitter. Here's their tweet:

"@${authorHandle}: ${mentionText}"

Write a short, witty reply. Rules:
- Keep it under 200 characters. Short is better.
- Be witty, confident, on-brand with the billionaire persona.
- Add value. Don't just agree — say something that makes people want to follow you.
- Be direct. No "great point!" or "thanks for mentioning!" energy.
- If it's a question, answer it with a take.
- If it's a compliment, acknowledge it with swagger, not gratitude.
- If it's a challenge or disagreement, respond with logic and wit. Don't get defensive.
- No emoji unless it's the punchline. No hashtags.

Return ONLY the reply text. No JSON, no quotes, no explanation. Just the reply.`;

  for (const model of models) {
    console.log(`[Mentions] Using model: ${model}`);
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
        max_tokens: 200,
        reasoning: { effort: "none" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (response.status === 402 || response.status === 429 || response.status >= 500) continue;
    if (!response.ok) continue;

    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      continue;
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) continue;

    const cleaned = content
      .replace(/^["']|["']$/g, "")
      .replace(/^```[\s\S]*?\n/, "")
      .replace(/\n```$/, "")
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 280) return cleaned;
  }

  return `Appreciate the mention, @${authorHandle}. Most people scroll past. You didn't. That already puts you ahead.`;
}

export function shouldAutoReply(mentionText: string): boolean {
  const text = mentionText.toLowerCase().trim();
  if (!text) return false;

  const spamPatterns = [
    "buy now", "click here", "free followers", "dm me", "check my profile",
    "investment opportunity", "crypto giveaway", "send eth", "claim your",
    "limited time", "act now", "promote your", "shoutout for",
  ];
  for (const pattern of spamPatterns) {
    if (text.includes(pattern)) return false;
  }

  const trollPatterns = [
    "you're stupid", "you're an idiot", "shut up", "nobody cares",
    "who asked", "touch grass", "ratio", "l + ", "cope", "seethe",
    "kill yourself", "go die", "hate you", "you suck",
  ];
  for (const pattern of trollPatterns) {
    if (text.includes(pattern)) return false;
  }

  const hatePatterns = [
    "slur", "racist", "sexist", "homophobic",
  ];
  for (const pattern of hatePatterns) {
    if (text.includes(pattern)) return false;
  }

  const engagementPatterns = [
    "?", "what do you think", "thoughts", "agree", "disagree",
    "great", "love this", "amazing", "brilliant", "spot on",
    "interesting", "good point", "well said", "thanks", "thank you",
    "how", "why", "when", "where", "can you", "could you",
    "tell me", "explain", "what's your", "what is your",
  ];
  for (const pattern of engagementPatterns) {
    if (text.includes(pattern)) return true;
  }

  if (text.includes("@") && text.length > 20) return true;

  return false;
}

export async function autoReplyToMentions(
  db: SupabaseClient,
  page: Page,
  ownHandle: string,
  apiKey: string,
): Promise<number> {
  const scraped = await scrapeMentions(page, ownHandle);
  if (!scraped.length) return 0;

  const knownUrls = await db.getKnownMentionUrls(500);
  const newMentions = scraped.filter((m) => !knownUrls.has(m.tweetUrl));
  if (!newMentions.length) return 0;

  for (const mention of newMentions) {
    await db.insertMentionQueueEntry({
      tweet_url: mention.tweetUrl,
      author_handle: mention.authorHandle,
      author_name: mention.authorName,
      tweet_text: mention.tweetText,
    });
  }

  const repliedUrls = await db.getRepliedMentionUrls(200);
  let replyCount = 0;

  for (const mention of newMentions) {
    if (repliedUrls.has(mention.tweetUrl)) continue;
    if (!shouldAutoReply(mention.tweetText)) continue;

    const replyText = await generateReplyToMention(apiKey, mention.tweetText, mention.authorHandle);
    const result = await postReply(page, mention.tweetUrl, replyText);

    if (result.success) {
      await db.markMentionReplied(mention.tweetUrl);
      replyCount++;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      console.log(`[Mentions] Failed to reply to ${mention.tweetUrl}: ${result.error}`);
    }
  }

  return replyCount;
}

async function postReply(page: Page, tweetUrl: string, replyText: string): Promise<{ success: boolean; error: string | null }> {
  try {
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (await checkForChallenge(page)) {
      return { success: false, error: "CHALLENGE: X is showing a challenge during reply. Stopping." };
    }

    const replyBox = await page.$('[data-testid="tweetTextarea_0"], div[contenteditable="true"][role="textbox"]').catch(() => null);
    if (!replyBox) {
      return { success: false, error: "Reply input not found" };
    }

    await replyBox.click();
    await page.waitForTimeout(500);
    await page.keyboard.type(replyText, { delay: 30 });
    await page.waitForTimeout(500);

    const replyButton = await page.$('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]').catch(() => null);
    if (!replyButton) {
      return { success: false, error: "Reply button not found" };
    }

    await replyButton.click();
    await page.waitForTimeout(3000);

    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error posting reply" };
  }
}
