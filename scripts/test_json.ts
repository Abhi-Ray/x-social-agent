import { config } from "dotenv";
config();
import { generateDrafts } from "../src/openrouter";
import { getFreeModels } from "../src/openrouter";
import type { ContextWindow } from "../src/types";

const apiKey = process.env.OPENROUTER_API_KEY!;

const emptyContext: ContextWindow = {
  recent_posts: [],
  recent_trends: [],
  recent_drafts: [],
  today_counters: null,
  verified_quotes_sample: [],
  persona_summary: "",
};

async function main() {
  console.log("=== Available models ===");
  const models = await getFreeModels(apiKey);
  for (const m of models) console.log(`  ${m}`);

  console.log("\n=== Generating with GPT-OSS first (if Hermes is rate limited) ===");
  const trends = [
    { topic_text: "ISRO Chandrayaan moon mission", category: "Science" },
    { topic_text: "India vs Pakistan cricket", category: "Sports" },
    { topic_text: "Indian startup unicorn 2026", category: "Business" },
    { topic_text: "Trending in India #MondayMotivation", category: "Trending" },
    { topic_text: "India GDP 8% growth", category: "Business" },
  ];

  const drafts = await generateDrafts(apiKey, emptyContext, trends);
  console.log(`\nGenerated ${drafts.length} drafts:\n`);
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    console.log(`--- Draft ${i + 1} (${d.action_type}) ---`);
    console.log(`Trend: ${d.trend_topic}`);
    console.log(`Text: "${d.draft_text}"`);
    console.log();
  }
}

main().catch(console.error);
