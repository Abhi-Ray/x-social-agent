import "dotenv/config";
import { loadEnv } from "./config";
import { SupabaseClient } from "./supabase";
import { runTick, runExecutor, runBotPolling } from "./orchestrator";
import { SEED_QUOTES } from "./persona";
import { sendTelegram, b } from "./telegram";
import { localDate, sleep } from "./config";
import type { Env } from "./types";

async function main() {
  const command = process.argv[2] ?? "cron";
  const env = loadEnv();
  const db = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  switch (command) {
    case "tick":
      await runTick(env, db);
      break;

    case "executor":
      await runExecutor(env, db);
      break;

    case "bot":
      await runBotPolling(env, db);
      break;

    case "seed-quotes":
      await seedQuotes(db);
      break;

    case "cron": {
      // Full mode: run bot polling + periodic ticks + periodic executor checks
      console.log("Starting X Social Agent in full cron mode...");
      console.log("Press Ctrl+C to stop.");

      const intervalMinutes = Number(env.CRON_INTERVAL_MINUTES) || 45;

      // Start bot polling in background (not blocking)
      runBotPolling(env, db).catch((err) => console.error("Bot polling crashed:", err));

      // Run initial tick
      await safeRun(() => runTick(env, db), env, "tick");

      // Main cron loop
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const intervalMs = intervalMinutes * 60 * 1000;
        console.log(`Next tick in ${intervalMinutes} minutes...`);

        // Wait for the interval, but also run executor checks every 5 minutes
        const executorIntervalMs = 5 * 60 * 1000;
        let elapsed = 0;
        while (elapsed < intervalMs) {
          await sleep(Math.min(executorIntervalMs, intervalMs - elapsed));
          elapsed += executorIntervalMs;

          // Run executor check
          await safeRun(() => runExecutor(env, db), env, "executor");
        }

        // Run tick
        await safeRun(() => runTick(env, db), env, "tick");
      }
    }

    case "daily-summary":
      await sendDailySummary(env, db);
      break;

    default:
      console.log(`Unknown command: ${command}`);
      console.log("Available commands: tick, executor, bot, cron, seed-quotes, daily-summary");
      process.exit(1);
  }
}

async function safeRun(fn: () => Promise<void>, env: Env, label: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${label} failed: ${message}`);
    try {
      await sendTelegram(env, b(`${label} failed: ${message}`));
    } catch {
      // Telegram might also fail
    }
  }
}

async function seedQuotes(db: SupabaseClient): Promise<void> {
  console.log(`Seeding ${SEED_QUOTES.length} verified quotes...`);
  for (const quote of SEED_QUOTES) {
    try {
      await db.insertVerifiedQuote(quote);
      console.log(`  Inserted: "${quote.text.slice(0, 50)}..." — ${quote.attributed_to}`);
    } catch (error) {
      console.error(`  Failed to insert quote: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log("Done seeding quotes.");
}

async function sendDailySummary(env: Env, db: SupabaseClient): Promise<void> {
  const today = localDate();
  const counter = await db.getDailyCounter(today);
  const { sendDailySummary: tgSendDailySummary } = await import("./telegram");
  await tgSendDailySummary(env, {
    posts: counter?.original_post ?? 0,
    replies: counter?.reply ?? 0,
    retweets: counter?.retweet_comment ?? 0,
    mentions: counter?.mention ?? 0,
    challenges: 0, // Would query health log
    failures: 0,
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
