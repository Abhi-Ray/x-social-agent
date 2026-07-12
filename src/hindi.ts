import { getFreeModels } from "./openrouter";
import { buildSystemPrompt } from "./persona";
import type { SupabaseClient } from "./supabase";
import type { PostedContent } from "./types";

function cleanContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

export interface HindiPostResult {
  text: string;
  script: "devanagari" | "hinglish";
  topic: string;
}

export async function generateHindiPost(
  apiKey: string,
  context: { recent_posts: PostedContent[]; persona_summary?: string },
  topic: string,
): Promise<HindiPostResult> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = buildSystemPrompt();

  const useDevanagari = Math.random() < 0.5;
  const script = useDevanagari ? "devanagari" : "hinglish";
  const scriptInstruction = useDevanagari
    ? "Write this post in Hindi using Devanagari script (हिंदी). Use simple, everyday Hindi that a mass Indian audience understands. Not formal literary Hindi — conversational Hindi."
    : "Write this post in Hinglish (Hindi written in Roman/English script). Like how young Indians actually text and talk. Mix Hindi words with English naturally. Example: 'Yeh sab paisa ka khel hai bro' or 'Zindagi mein risk lena padta hai.'";

  const recentPostsSection = context.recent_posts.length
    ? context.recent_posts.slice(0, 10).map((p, i) => `  ${i + 1}. "${p.posted_text}"`).join("\n")
    : "No recent posts.";

  const userPrompt = `Generate ONE X/Twitter post in Hindi/Hinglish about this topic: "${topic}"

${scriptInstruction}

Same persona rules apply — billionaire mindset, sarcastic, funny, opinionated, simple language. But adapted for Indian mass audience:
- Relatable to everyday Indian life (jobs, money, traffic, cricket, family, startups, exams, politics)
- Punchy and short — 1-2 lines max, under 280 characters
- No hashtags unless it's the joke (max 1)
- No emoji unless it's the punchline (max 1)
- Write like a real person, not a brand
- Don't repeat topics or angles from recent posts

YOUR RECENT POSTS (do NOT repeat):
${recentPostsSection}

Return ONLY a JSON object with this exact shape:
{"text":"the post text","script":"${script}","topic":"${topic}"}

Rules:
- text MUST be under 280 characters
- text MUST be in the correct script (${script})
- Keep it simple — a 12-year-old should understand it
- Be funny and opinionated, not preachy
- Start with { and end with }`;

  const errors: string[] = [];
  for (const model of models) {
    console.log(`[Hindi] Using model: ${model}`);
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
          max_tokens: 1000,
          reasoning: { effort: "none" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: attempt === 0
                ? userPrompt
                : `${userPrompt}\nYour prior response failed validation. Return ONLY the exact JSON shape requested. No thinking, no explanation. Start with { and end with }.`,
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
        const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
        if (!text) throw new Error("Missing text field");
        if (text.length > 280) throw new Error(`Text exceeds 280 chars (${text.length})`);
        const resultScript = typeof parsed.script === "string" && (parsed.script === "devanagari" || parsed.script === "hinglish")
          ? parsed.script
          : script;
        const resultTopic = typeof parsed.topic === "string" ? parsed.topic.trim() : topic;
        return { text, script: resultScript, topic: resultTopic };
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "validation failed"} (content: ${content.slice(0, 200)})`);
      }
    }
  }
  throw new Error(`All free OpenRouter models failed for Hindi post: ${errors.slice(-6).join("; ")}`);
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

export async function shouldPostInHindi(db: SupabaseClient, lastNHindiPosts = 10): Promise<boolean> {
  const recent = await db.getRecentPosts(lastNHindiPosts);
  if (!recent.length) return false;

  const hindiPostCount = await db.getRecentHindiPostCount(lastNHindiPosts);

  const positionInCycle = recent.length % 4;
  if (positionInCycle === 3) {
    if (hindiPostCount >= 2) return false;
    return true;
  }

  if (hindiPostCount >= 1) return false;

  return false;
}

export async function translateToHinglish(apiKey: string, englishText: string): Promise<string> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = `You translate English X/Twitter posts into Hinglish — Hindi written in Roman/English script. You keep the exact same wit, tone, sarcasm, and punch. The translation should sound like how a young, smart Indian person would say the same thing naturally. Not a literal translation — a natural Hinglish version that hits the same way.`;

  const userPrompt = `Translate this X post into Hinglish (Hindi in Roman script):

"${englishText}"

Rules:
- Keep it under 280 characters
- Mix Hindi and English naturally like young Indians actually talk
- Preserve the sarcasm, wit, and tone exactly
- Don't add or remove meaning
- No hashtags unless the original had one
- No emoji unless the original had one
- Return ONLY the translated text, nothing else. No JSON, no explanation.`;

  const errors: string[] = [];
  for (const model of models) {
    console.log(`[Hindi] Translate using model: ${model}`);
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
        max_tokens: 500,
        reasoning: { effort: "none" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (response.status === 402 || response.status === 429 || response.status >= 500) {
      errors.push(`${model}: HTTP ${response.status}`);
      continue;
    }
    if (!response.ok) {
      errors.push(`${model}: HTTP ${response.status}`);
      continue;
    }

    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      errors.push(`${model}: invalid API response`);
      continue;
    }

    let content = body.choices?.[0]?.message?.content;
    if (content) content = cleanContent(content);
    if (!content) {
      errors.push(`${model}: empty response`);
      continue;
    }

    const translated = content.trim().replace(/^["']|["']$/g, "").replace(/^```|```$/g, "").trim();
    if (translated && translated.length <= 280) return translated;
    if (translated) return translated.slice(0, 280);
    errors.push(`${model}: empty translation`);
  }
  throw new Error(`All free OpenRouter models failed for Hinglish translation: ${errors.slice(-6).join("; ")}`);
}
