import type { ContextWindow, ABVariantResult, ABTestVariant } from "./types";
import { buildSystemPrompt, buildContextSection } from "./persona";
import { getFreeModels } from "./openrouter";
import { SupabaseClient } from "./supabase";

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

function validateVariants(value: Record<string, unknown>, topic: string): ABVariantResult {
  const variantA = value.variant_a;
  const variantB = value.variant_b;
  if (typeof variantA !== "string" || !variantA.trim()) throw new Error("Invalid or missing variant_a");
  if (typeof variantB !== "string" || !variantB.trim()) throw new Error("Invalid or missing variant_b");
  if (variantA.length > 280) throw new Error(`Variant A exceeds 280 chars (${variantA.length})`);
  if (variantB.length > 280) throw new Error(`Variant B exceeds 280 chars (${variantB.length})`);
  if (variantA.trim() === variantB.trim()) throw new Error("Variants A and B are identical");
  return { variantA: variantA.trim(), variantB: variantB.trim(), topic };
}

export async function generateABVariants(
  apiKey: string,
  context: ContextWindow,
  topic: string,
): Promise<ABVariantResult> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = buildSystemPrompt();
  const contextSection = buildContextSection(context);

  const userPrompt = `Generate TWO different posts (variants A and B) on the same topic: "${topic}"

${contextSection}

Return ONLY a JSON object with this exact shape:
{"variant_a":"text of variant A","variant_b":"text of variant B"}

Rules:
- Variant A and Variant B must be DIFFERENT angles, tones, or hooks on the same topic.
- Variant A: try a direct, bold, contrarian take.
- Variant B: try a question, story, or pattern-interrupt style.
- Each variant MUST be under 280 characters. SHORTER IS BETTER — aim for 1-2 lines.
- WRITE SIMPLE. A 12-year-old should understand every post. No big words. No long sentences.
- Be funny, sarcastic, opinionated. No corporate bot energy.
- No hashtag spam (0-1 max, only if it's the joke).
- No emoji spam (1 max, only if it's the punchline).
- Do NOT repeat topics or angles from recent posts shown in context.
- Both variants should be strong enough to go viral on their own.`;

  const errors: string[] = [];
  for (const model of models) {
    console.log(`[ABTest] Using model: ${model}`);
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
          temperature: 0.7,
          max_tokens: 2000,
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
        return validateVariants(parsed, topic);
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "validation failed"} (content: ${content.slice(0, 200)})`);
      }
    }
  }
  throw new Error(`All free OpenRouter models failed for A/B variant generation: ${errors.slice(-6).join("; ")}`);
}

export async function recordABResult(
  db: SupabaseClient,
  testGroup: string,
  variant: "A" | "B",
  engagement: { engagement_likes: number; engagement_retweets: number; engagement_replies: number },
): Promise<void> {
  const variants = await db.getABTestGroup(testGroup);
  const target = variants.find((v) => v.variant === variant);
  if (!target) throw new Error(`Variant ${variant} not found in test group ${testGroup}`);
  await db.updateABVariantEngagement(target.id, engagement);
}

export async function pickWinner(
  db: SupabaseClient,
  testGroup: string,
): Promise<{ winner: ABTestVariant | null; variantA: ABTestVariant | null; variantB: ABTestVariant | null }> {
  const variants = await db.getABTestGroup(testGroup);
  const variantA = variants.find((v) => v.variant === "A") ?? null;
  const variantB = variants.find((v) => v.variant === "B") ?? null;

  if (!variantA || !variantB) {
    return { winner: null, variantA, variantB };
  }

  const scoreA = (variantA.engagement_likes ?? 0) + (variantA.engagement_retweets ?? 0) + (variantA.engagement_replies ?? 0);
  const scoreB = (variantB.engagement_likes ?? 0) + (variantB.engagement_retweets ?? 0) + (variantB.engagement_replies ?? 0);

  if (scoreA === 0 && scoreB === 0) {
    return { winner: null, variantA, variantB };
  }

  const winner = scoreA >= scoreB ? variantA : variantB;
  await db.markABVariantWinner(winner.id);

  return { winner, variantA, variantB };
}
