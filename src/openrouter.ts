import type { ContextWindow, GeneratedDraft } from "./types";
import { buildSystemPrompt, buildContextSection } from "./persona";

// Same preferred free models as jarvis-assistant — discovered at runtime and filtered to free
export const preferredModels = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "tencent/hy3:free",
  "meta-llama/llama-3.3-70b-instruct:free",
] as const;

interface ModelRecord {
  id?: string;
  pricing?: { prompt?: string; completion?: string };
}

export async function getFreeModels(apiKey: string): Promise<string[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenRouter model discovery failed: ${response.status}`);
  let body: { data?: ModelRecord[] };
  try {
    body = await response.json() as { data?: ModelRecord[] };
  } catch {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter model discovery returned invalid JSON: ${text.slice(0, 200)}`);
  }
  const available = new Set(
    (body.data ?? [])
      .filter((model) => model.id && (model.id.endsWith(":free") || (model.pricing?.prompt === "0" && model.pricing?.completion === "0")))
      .map((model) => model.id as string),
  );
  const selected = preferredModels.filter((model) => available.has(model));
  if (!selected.length) {
    // Fallback: use any available free model
    const anyFree = [...available].slice(0, 3);
    if (!anyFree.length) throw new Error(`No free OpenRouter models available. Preferred: ${preferredModels.join(", ")}`);
    return anyFree;
  }
  return selected;
}

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

function validateDraft(value: Record<string, unknown>): GeneratedDraft {
  const actionType = value.action_type;
  if (typeof actionType !== "string" || !["original_post", "reply", "retweet_comment", "mention"].includes(actionType)) {
    throw new Error("Invalid or missing action_type");
  }
  const draftText = value.draft_text;
  if (typeof draftText !== "string" || !draftText.trim()) throw new Error("Invalid or missing draft_text");
  if (draftText.length > 280) throw new Error(`Draft text exceeds 280 chars (${draftText.length})`);

  return {
    action_type: actionType as GeneratedDraft["action_type"],
    draft_text: draftText.trim(),
    source_tweet_url: typeof value.source_tweet_url === "string" ? value.source_tweet_url : null,
    source_tweet_text: typeof value.source_tweet_text === "string" ? value.source_tweet_text : null,
    source_tweet_author: typeof value.source_tweet_author === "string" ? value.source_tweet_author : null,
    quote_text: typeof value.quote_text === "string" ? value.quote_text.trim() || null : null,
    quote_attributed_to: typeof value.quote_attributed_to === "string" ? value.quote_attributed_to.trim() || null : null,
    quote_source: typeof value.quote_source === "string" ? value.quote_source.trim() || null : null,
    trend_topic: typeof value.trend_topic === "string" ? value.trend_topic.trim() || null : null,
  };
}

export async function generateDrafts(
  apiKey: string,
  context: ContextWindow,
  trends: Array<{ topic_text: string; category: string | null }>,
  viralTweets?: Array<{ trend: string; tweet: { url: string; text: string; author: string; authorHandle: string; engagement?: { likes: number; retweets: number; replies: number } } }>,
): Promise<GeneratedDraft[]> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = buildSystemPrompt();
  const contextSection = buildContextSection(context);
  const trendsSection = trends.map((t, i) => `${i + 1}. ${t.topic_text}${t.category ? ` [${t.category}]` : ""}`).join("\n");

  // Build viral tweet targets section for reply drafts
  let viralSection = "";
  if (viralTweets && viralTweets.length > 0) {
    viralSection = "\n\nVIRAL TWEETS TO REPLY TO (high engagement — replying gets you discovered):\n";
    viralSection += viralTweets.map((v, i) => {
      const eng = v.tweet.engagement;
      const engStr = eng ? ` [${eng.likes} likes, ${eng.retweets} RTs]` : "";
      return `  ${i + 1}. @${v.tweet.authorHandle} (${v.tweet.author})${engStr}\     Tweet: "${v.tweet.text.slice(0, 200)}"\n     URL: ${v.tweet.url}\n     Trend: ${v.trend}`;
    }).join("\n");
    viralSection += "\n\nPRIORITY: Generate at least 1 reply draft to a viral tweet above. Replies to viral tweets are the #1 growth hack — your reply shows up to everyone who engages with the original tweet.";
  }

  const userPrompt = `Generate 1-3 draft posts based on the trending topics below. Use the persona and rules from the system prompt.

${contextSection}

TRENDING TOPICS RIGHT NOW:
${trendsSection}${viralSection}

Return ONLY a JSON object with this exact shape:
{"drafts":[{"action_type":"original_post|reply|retweet_comment|mention","draft_text":"...","source_tweet_url":"url if replying to a tweet, else null","source_tweet_text":"text of tweet being replied to, else null","source_tweet_author":"@handle of tweet author, else null","quote_text":"optional verified quote text or null","quote_attributed_to":"optional figure name or null","quote_source":"optional source work or null","trend_topic":"the trend this relates to"}]}

Rules:
- 1-3 drafts max.
- If viral tweets are provided, make at least 1 a reply (action_type="reply") with source_tweet_url set.
- Each draft_text MUST be under 280 characters. SHORTER IS BETTER — aim for 1-2 lines.
- If you use a quote, it MUST be from the verified quotes provided in context. If no fitting quote exists, set quote fields to null.
- Do NOT repeat topics or angles from recent posts shown in context.
- Do NOT use hashtags unless it's the joke (max 1).
- Do NOT use emoji unless it's the punchline (max 1).
- WRITE SIMPLE. A 12-year-old should understand every post. No big words. No long sentences.
- Be funny, sarcastic, opinionated. No corporate bot energy.
- No real personal info about anyone.
- For replies: be direct, witty, add value. Don't just agree — say something that makes people want to follow you.`;

  const errors: string[] = [];
  for (const model of models) {
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
          temperature: 0.4,
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
        const draftsRaw = parsed.drafts;
        if (!Array.isArray(draftsRaw)) throw new Error("Missing drafts array");
        const drafts = draftsRaw.map((d) => validateDraft(isRecord(d) ? d : {}));
        if (!drafts.length) throw new Error("No drafts generated");
        return drafts;
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "validation failed"} (content: ${content.slice(0, 200)})`);
      }
    }
  }
  throw new Error(`All free OpenRouter models failed: ${errors.slice(-6).join("; ")}`);
}
