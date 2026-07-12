import { config } from "dotenv";
config();
import { handleTelegramUpdate } from "../src/bot";
import { SupabaseClient } from "../src/supabase";
import type { Env } from "../src/types";

const env: Env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  TELEGRAM_ALLOWED_CHAT_IDS: process.env.TELEGRAM_ALLOWED_CHAT_IDS!,
  TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS!,
  TELEGRAM_TARGET_CHAT_ID: process.env.TELEGRAM_TARGET_CHAT_ID!,
  X_HANDLE: process.env.X_HANDLE!,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!, STORAGE_STATE_PATH: process.env.STORAGE_STATE_PATH ?? "storageState.json", CRON_INTERVAL_MINUTES: Number(process.env.CRON_INTERVAL_MINUTES ?? 45),
};

const db = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const commands = [
  "/help",
  "/status",
  "/pending",
  "/posts",
  "/engagement",
  "/competitors",
  "/templates",
  "/sentiment",
  "/trends",
  "/pillars",
  "/followers",
  "/health",
];

async function main() {
  for (const cmd of commands) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TESTING: ${cmd}`);
    console.log("=".repeat(60));

    const update = {
      update_id: Math.floor(Math.random() * 1000000),
      message: {
        message_id: Math.floor(Math.random() * 1000000),
        from: { id: 1312844323, is_bot: false, first_name: "Test" },
        chat: { id: 1312844323, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: cmd,
      },
    };

    try {
      await handleTelegramUpdate(env, update, db);
      console.log(`✓ ${cmd} — handled successfully`);
    } catch (e) {
      console.log(`✗ ${cmd} — ERROR: ${e instanceof Error ? e.stack : e}`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("ALL COMMANDS TESTED — Check your Telegram for responses");
  console.log("=".repeat(60));
}

main().catch(console.error);
