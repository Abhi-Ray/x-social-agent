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

async function main() {
  // 1. Get a pending draft
  const drafts = await db.getRecentDrafts(5);
  const pending = drafts.find((d) => d.status === "pending_approval");

  if (!pending) {
    console.log("No pending drafts found. Creating a test draft...");
    await db.insertDraft({
      
      action_type: "original_post",
      source_tweet_url: null,
      source_tweet_text: null,
      source_tweet_author: null,
      draft_text: "Test draft for approval flow testing",
      quote_text: null,
      quote_attributed_to: null,
      quote_source: null,
      trend_topic: "test",
      status: "pending_approval",
      telegram_message_id: null,
      created_at: new Date().toISOString(),
    });
    const fresh = await db.getRecentDrafts(1);
    const testDraft = fresh[0];
    if (!testDraft) {
      console.log("Failed to create test draft");
      return;
    }
    console.log(`Created test draft: ${testDraft.id}`);
    await testApprovalFlow(testDraft.id);
  } else {
    console.log(`Found pending draft: ${pending.id}`);
    console.log(`Draft text: "${pending.draft_text.slice(0, 80)}..."`);
    await testApprovalFlow(pending.id);
  }
}

async function testApprovalFlow(draftId: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 1: APPROVE draft");
  console.log("=".repeat(60));
  try {
    const approveUpdate = {
      update_id: Math.floor(Math.random() * 1000000),
      callback_query: {
        id: "test_callback_1",
        data: `approve:${draftId}`,
        message: { message_id: 123, chat: { id: 1312844323 }, text: "test" },
        from: { id: 1312844323 },
      },
    };
    await handleTelegramUpdate(env, approveUpdate, db);
    console.log("✓ APPROVE — handled successfully");

    // Check status
    const draft = await db.getDraftById(draftId);
    console.log(`  Draft status after approve: ${draft?.status}`);
  } catch (e) {
    console.log(`✗ APPROVE — ERROR: ${e instanceof Error ? e.stack : e}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 2: REJECT draft (create new draft first)");
  console.log("=".repeat(60));

  // Create another draft for reject test
  await db.insertDraft({
    
    action_type: "original_post",
    source_tweet_url: null,
    source_tweet_text: null,
    source_tweet_author: null,
    draft_text: "Test draft for rejection",
    quote_text: null,
    quote_attributed_to: null,
    quote_source: null,
    trend_topic: "test_reject",
    status: "pending_approval",
    telegram_message_id: null,
    created_at: new Date().toISOString(),
  });
  const freshDrafts = await db.getRecentDrafts(5);
  const rejectDraft = freshDrafts.find((d) => d.draft_text === "Test draft for rejection");

  if (rejectDraft) {
    try {
      const rejectUpdate = {
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: "test_callback_2",
          data: `reject:${rejectDraft.id}`,
          message: { message_id: 124, chat: { id: 1312844323 }, text: "test" },
          from: { id: 1312844323 },
        },
      };
      await handleTelegramUpdate(env, rejectUpdate, db);
      console.log("✓ REJECT — handled successfully");
      const draft = await db.getDraftById(rejectDraft.id);
      console.log(`  Draft status after reject: ${draft?.status}`);
    } catch (e) {
      console.log(`✗ REJECT — ERROR: ${e instanceof Error ? e.stack : e}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 3: EDIT draft (create new draft first)");
  console.log("=".repeat(60));

  await db.insertDraft({
    
    action_type: "original_post",
    source_tweet_url: null,
    source_tweet_text: null,
    source_tweet_author: null,
    draft_text: "Test draft for editing",
    quote_text: null,
    quote_attributed_to: null,
    quote_source: null,
    trend_topic: "test_edit",
    status: "pending_approval",
    telegram_message_id: null,
    created_at: new Date().toISOString(),
  });
  const editDrafts = await db.getRecentDrafts(5);
  const editDraft = editDrafts.find((d) => d.draft_text === "Test draft for editing");

  if (editDraft) {
    try {
      const editUpdate = {
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: "test_callback_3",
          data: `edit:${editDraft.id}`,
          message: { message_id: 125, chat: { id: 1312844323 }, text: "test" },
          from: { id: 1312844323 },
        },
      };
      await handleTelegramUpdate(env, editUpdate, db);
      console.log("✓ EDIT — handled successfully (waiting for user text)");
    } catch (e) {
      console.log(`✗ EDIT — ERROR: ${e instanceof Error ? e.stack : e}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("APPROVAL FLOW TESTS COMPLETE — Check Telegram");
  console.log("=".repeat(60));
}

main().catch(console.error);
