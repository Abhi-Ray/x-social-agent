import { config } from "dotenv";
config();
import { SupabaseClient } from "../src/supabase";
import { analyzeDraftStyle, logRejection, buildRejectionFeedback } from "../src/rejection";
import { handleTelegramUpdate } from "../src/bot";
import type { Env } from "../src/types";

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

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log("=".repeat(60));
  try {
    await fn();
    console.log(`✓ ${name} — PASSED`);
  } catch (e) {
    console.log(`✗ ${name} — FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  // 1. Test style analysis
  await test("Draft Style Analysis", async () => {
    const critical = analyzeDraftStyle("Goa wants Mumbai money without Mumbai problems. Good luck.");
    console.log(`  Critical draft: is_critical=${critical.is_critical}, is_positive=${critical.is_positive}, is_sarcastic=${critical.is_sarcastic}, words=${critical.word_count}`);

    const positive = analyzeDraftStyle("India's GDP just hit 8.2%. Fastest growing economy. Again. Incredible achievement.");
    console.log(`  Positive draft: is_critical=${positive.is_critical}, is_positive=${positive.is_positive}, words=${positive.word_count}`);

    const sarcastic = analyzeDraftStyle("Oh sure, because printing more money always works. Who knew. Bless them.");
    console.log(`  Sarcastic draft: is_sarcastic=${sarcastic.is_sarcastic}, words=${sarcastic.word_count}`);

    if (!critical.is_critical) throw new Error("Should detect critical style");
    if (!positive.is_positive) throw new Error("Should detect positive style");
    if (!sarcastic.is_sarcastic) throw new Error("Should detect sarcastic style");
  });

  // 2. Test rejection logging
  await test("Rejection Logging", async () => {
    const result = await logRejection(db, {
      id: "test-draft-1",
      draft_text: "This is a test critical post about test_topic_abc. Good luck with that.",
      trend_topic: "test_topic_abc",
      action_type: "original_post",
    });
    console.log(`  Rejection logged. Result: ${JSON.stringify(result)}`);
  });

  // 3. Test blocked topics — reject same topic twice
  await test("Blocked Topics (2 rejections → blocked)", async () => {
    // First rejection
    const r1 = await logRejection(db, {
      id: "test-draft-2a",
      draft_text: "Test post about blocked_topic_xyz. This is terrible.",
      trend_topic: "blocked_topic_xyz",
      action_type: "original_post",
    });
    console.log(`  1st rejection: ${JSON.stringify(r1)}`);
    if (r1?.blocked) throw new Error("Should NOT be blocked after 1st rejection");

    // Second rejection
    const r2 = await logRejection(db, {
      id: "test-draft-2b",
      draft_text: "Another post about blocked_topic_xyz. Still terrible.",
      trend_topic: "blocked_topic_xyz",
      action_type: "original_post",
    });
    console.log(`  2nd rejection: ${JSON.stringify(r2)}`);
    if (!r2?.blocked) throw new Error("Should be blocked after 2nd rejection");

    // Check it's in the blocked list
    const blocked = await db.getBlockedTopics();
    console.log(`  Blocked topics: ${blocked.join(", ")}`);
    if (!blocked.includes("blocked_topic_xyz")) throw new Error("Topic should be in blocked list");
  });

  // 4. Test rejection feedback for prompt
  await test("Rejection Feedback for Prompt", async () => {
    const feedback = await buildRejectionFeedback(db);
    console.log(`  Feedback length: ${feedback.length} chars`);
    if (feedback) {
      console.log(`  Feedback preview:\n${feedback.slice(0, 300)}...`);
    }
  });

  // 5. Test isTopicBlocked
  await test("isTopicBlocked check", async () => {
    const isBlocked = await db.isTopicBlocked("blocked_topic_xyz");
    console.log(`  blocked_topic_xyz blocked: ${isBlocked}`);
    if (!isBlocked) throw new Error("Should be blocked");

    const notBlocked = await db.isTopicBlocked("some_random_topic");
    console.log(`  some_random_topic blocked: ${notBlocked}`);
    if (notBlocked) throw new Error("Should NOT be blocked");
  });

  // 6. Test unblock
  await test("Unblock Topic", async () => {
    await db.unblockTopic("blocked_topic_xyz");
    const isBlocked = await db.isTopicBlocked("blocked_topic_xyz");
    console.log(`  After unblock, blocked: ${isBlocked}`);
    if (isBlocked) throw new Error("Should be unblocked");
  });

  // 7. Test daily summary log
  await test("Daily Summary Log (once per day)", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const alreadySent = await db.hasDailySummaryBeenSent(today);
    console.log(`  Already sent today (${today}): ${alreadySent}`);

    if (!alreadySent) {
      await db.logDailySummary({
        summary_date: today,
        posts_count: 5,
        total_likes: 100,
        total_retweets: 20,
        total_replies: 10,
      });
      const sentAfter = await db.hasDailySummaryBeenSent(today);
      console.log(`  After logging, sent: ${sentAfter}`);
      if (!sentAfter) throw new Error("Should be marked as sent");
    }
  });

  // 8. Test bot reject callback (integration)
  await test("Bot Reject Callback (integration)", async () => {
    // Create a test draft
    await db.insertDraft({
      action_type: "original_post",
      source_tweet_url: null,
      source_tweet_text: null,
      source_tweet_author: null,
      draft_text: "Test rejection integration draft about test_integration_topic",
      quote_text: null,
      quote_attributed_to: null,
      quote_source: null,
      trend_topic: "test_integration_topic",
      telegram_message_id: null,
    });
    const drafts = await db.getRecentDrafts(1);
    const testDraft = drafts[0];
    if (!testDraft) throw new Error("Failed to create test draft");

    // Send reject callback
    const update = {
      update_id: Math.floor(Math.random() * 1000000),
      callback_query: {
        id: "test_reject_cb",
        data: `reject:${testDraft.id}`,
        message: { message_id: 999, chat: { id: 1312844323 }, text: "test" },
        from: { id: 1312844323 },
      },
    };
    await handleTelegramUpdate(env, update, db);

    // Verify rejection was logged
    const draft = await db.getDraftById(testDraft.id);
    console.log(`  Draft status after reject: ${draft?.status}`);
    if (draft?.status !== "rejected") throw new Error("Draft should be rejected");
  });

  // Cleanup test data
  await test("Cleanup test data", async () => {
    // Unblock test topics
    await db.unblockTopic("test_topic_abc");
    await db.unblockTopic("test_integration_topic");
    await db.unblockTopic("blocked_topic_xyz");
    console.log("  Test topics unblocked");
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log("ALL REJECTION LEARNING TESTS COMPLETE");
  console.log("=".repeat(60));
}

main().catch(console.error);
