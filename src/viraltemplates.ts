import type { SupabaseClient } from "./supabase";
import type { ViralTemplate } from "./types";
import { preferredModels, getFreeModels } from "./openrouter";

export interface ExtractedTemplate {
  template: string;
  pattern: string | null;
  placeholders: string[];
}

interface TemplateFillContext {
  topic?: string;
  trend?: string;
  pillar?: string;
}

const KNOWN_PATTERNS: Array<{ regex: RegExp; pattern: string; placeholder: string }> = [
  { regex: /^Nobody talks about /i, pattern: "Nobody talks about [TOPIC]", placeholder: "[TOPIC]" },
  { regex: /^Unpopular opinion:\s*/i, pattern: "Unpopular opinion: [TOPIC]", placeholder: "[TOPIC]" },
  { regex: /^The biggest /i, pattern: "The biggest [TOPIC] in India is [TOPIC]", placeholder: "[TOPIC]" },
  { regex: /^Nobody is going to tell you /i, pattern: "Nobody is going to tell you [TOPIC]", placeholder: "[TOPIC]" },
  { regex: /^What's something /i, pattern: "What's something [TOPIC]?", placeholder: "[TOPIC]" },
];

const ENTITY_PATTERNS: Array<{ regex: RegExp; placeholder: string }> = [
  { regex: /\b(?:₹|rs\.?|inr)\s?[\d,]+(?:\.\d+)?\s?(?:crore|lakh|cr|lakh|billion|million)?/gi, placeholder: "[NUMBER]" },
  { regex: /\b[\d,]+(?:\.\d+)?(?:%| percent| crore| lakh| billion| million|x)\b/gi, placeholder: "[NUMBER]" },
  { regex: /\b(?:reliance|tata|infosys|zomato|swiggy|flipkart|paytm|phonepe|byju'?s|unacademy|cred|upi|sbi|hdfc|icici)\b/gi, placeholder: "[COMPANY]" },
  { regex: /@[A-Za-z0-9_]+/g, placeholder: "[PERSON]" },
];

export function extractTemplate(postText: string): ExtractedTemplate {
  let template = postText.trim();
  let pattern: string | null = null;
  const placeholders: Set<string> = new Set();

  for (const known of KNOWN_PATTERNS) {
    if (known.regex.test(template)) {
      pattern = known.pattern;
      break;
    }
  }

  for (const entity of ENTITY_PATTERNS) {
    if (entity.regex.test(template)) {
      placeholders.add(entity.placeholder);
      template = template.replace(entity.regex, entity.placeholder);
    }
  }

  if (!pattern) {
    if (template.includes("[TOPIC]")) {
      pattern = "Custom [TOPIC] pattern";
    } else if (placeholders.size === 0) {
      pattern = null;
    } else {
      const phs = [...placeholders].join(" + ");
      pattern = `Custom ${phs} pattern`;
    }
  }

  if (!template.includes("[TOPIC]") && placeholders.size === 0) {
    const words = template.split(/\s+/);
    if (words.length > 4) {
      const midIdx = Math.floor(words.length / 2);
      words.splice(midIdx, 1, "[TOPIC]");
      template = words.join(" ");
      placeholders.add("[TOPIC]");
    }
  }

  return { template, pattern, placeholders: [...placeholders] };
}

export async function storeViralTemplate(
  db: SupabaseClient,
  template: string,
  source: string,
  engagement: number,
): Promise<void> {
  await db.insertViralTemplate({
    template,
    source,
    avg_engagement: engagement,
    times_used: 0,
  });
}

export async function getTopTemplates(db: SupabaseClient, limit = 10): Promise<ViralTemplate[]> {
  return db.getTopViralTemplates(limit);
}

export async function fillTemplate(
  template: string,
  context: TemplateFillContext,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return template;

  let models: string[] = [];
  try {
    models = await getFreeModels(apiKey);
  } catch {
    models = [...preferredModels];
  }
  if (!models.length) return template;

  const topicHint = context.topic ?? context.trend ?? context.pillar ?? "a trending topic in India";
  const systemPrompt = "You fill in viral post templates with witty, punchy content. Return ONLY the filled post text. No explanation, no quotes, no markdown.";
  const userPrompt = `Fill in this viral post template. Make it funny, sarcastic, and relatable to an Indian audience. Keep it under 280 characters.

Template:
${template}

Context — use this as inspiration for the topic:
${topicHint}

Rules:
- Replace ALL placeholders like [TOPIC], [NUMBER], [COMPANY], [PERSON] with real content.
- Keep the structure and tone of the template.
- Be specific and witty. No generic filler.
- Return ONLY the filled post text. Nothing else.`;

  for (const model of models) {
    try {
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
          temperature: 0.6,
          max_tokens: 500,
          reasoning: { effort: "none" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!response.ok) continue;
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content?.trim();
      if (content) {
        return content.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
      }
    } catch {
      continue;
    }
  }

  return template;
}

export async function shouldUseTemplate(db: SupabaseClient): Promise<boolean> {
  if (Math.random() > 0.3) return false;

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const usedToday = await db.getTemplatesUsedToday(today);
  return usedToday === 0;
}

export async function getUnusedTemplate(db: SupabaseClient): Promise<ViralTemplate | null> {
  return db.getUnusedViralTemplate();
}
