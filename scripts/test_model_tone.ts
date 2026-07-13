import { config } from "dotenv";
config();
import { generateDrafts } from "../src/openrouter";
import { generateHindiPost } from "../src/hindi";
import { generateThread } from "../src/threads";
import { SupabaseClient } from "../src/supabase";
import { getFreeModels } from "../src/openrouter";
import type { Env, ContextWindow } from "../src/types";

const env: Env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  TELEGRAM_ALLOWED_CHAT_IDS: process.env.TELEGRAM_ALLOWED_CHAT_IDS!,
  TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS!,
  TELEGRAM_TARGET_CHAT_ID: process.env.TELEGRAM_TARGET_CHAT_ID!,
  X_HANDLE: process.env.X_HANDLE!,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  STORAGE_STATE_PATH: process.env.STORAGE_STATE_PATH ?? "storageState.json",
  CRON_INTERVAL_MINUTES: Number(process.env.CRON_INTERVAL_MINUTES ?? 45),
};

const db = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const apiKey = env.OPENROUTER_API_KEY;

const emptyContext: ContextWindow = {
  recent_posts: [],
  recent_trends: [],
  recent_drafts: [],
  today_counters: null,
  verified_quotes_sample: [],
  persona_summary: "",
};

async function main() {
  // 1. Show which models are available
  console.log("=== Available Free Models (ordered by preference) ===");
  const models = await getFreeModels(apiKey);
  for (const m of models) {
    console.log(`  ${m}`);
  }
  console.log();

  // 2. Generate drafts with Indian trends
  console.log("=== Generating Drafts with NEW Model + POSITIVE Tone ===");
  console.log("Trends: ISRO, Indian startups, IPL, Indian economy, Chennai Super Kings");
  const trends = [
    { topic_text: "ISRO moon mission", category: "Science" },
    { topic_text: "Indian startup unicorn", category: "Business" },
    { topic_text: "Chennai Super Kings IPL", category: "Sports" },
    { topic_text: "India GDP growth", category: "Business" },
    { topic_text: "Trending in India #MondayMotivation", category: "Trending" },
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

  // 3. Generate a Hindi post
  console.log("=== Hindi Post (new model + positive tone) ===");
  const hindi = await generateHindiPost(apiKey, { recent_posts: [] }, "Indian cricket team winning");
  console.log(`Script: ${hindi.script}`);
  console.log(`Text: "${hindi.text}"`);
  console.log();

  // 4. Generate a thread
  console.log("=== Thread (new model + positive tone) ===");
  const thread = await generateThread(apiKey, emptyContext, "Why India's tech boom is real");
  console.log(`Thread: ${thread.length} tweets`);
  for (let i = 0; i < thread.length; i++) {
    console.log(`  ${i + 1}. "${thread[i]}"`);
  }
  console.log();

  console.log("=== TEST COMPLETE ===");
}

main().catch(console.error);
