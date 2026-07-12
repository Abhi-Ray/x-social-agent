import type { Env } from "./types";
import { SupabaseClient } from "./supabase";
import { launchSession, closeSession, isLoggedIn, checkForChallenge } from "./session";
import { scrapeTrending } from "./scraper";
import { generateAndStoreDrafts } from "./generator";
import { sendDraftForApproval, sendTelegram, b } from "./telegram";
import { executeAction } from "./executor";
import { DAILY_CAPS, MIN_GAP_SECONDS, JITTER_SECONDS, MAX_DRAFTS_PER_TICK, localDate, sleep, hashText } from "./config";
import type { ActionType } from "./types";

// ─── Main tick: scrape trends → generate drafts → push to Telegram ───
export async function runTick(env: Env, db: SupabaseClient): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting tick...`);

  // 1. Launch Playwright session
  const { browser, context, page } = await launchSession(true);

  try {
    // 2. Check if logged in
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await sendTelegram(env, b("ALERT: X session expired. Run `npm run login` to re-authenticate."));
      console.error("X session expired. Run `npm run login` to re-authenticate.");
      return;
    }

    // 3. Check for challenge
    if (await checkForChallenge(page)) {
      await sendTelegram(env, b("ALERT: X is showing a challenge page. Stopping all automation. Manual intervention required."));
      await db.logHealthEvent(localDate(), "challenge", "Challenge page detected during tick");
      return;
    }

    // 4. Scrape trending topics
    console.log("Scraping trending topics...");
    const trends = await scrapeTrending(page);
    if (!trends.length) {
      console.log("No trends found. Skipping tick.");
      return;
    }

    // 5. Store trends in Supabase
    await db.insertTrends(trends.map((t) => ({ topic_text: t.topic_text, category: t.category })));
    console.log(`Scraped ${trends.length} trends.`);

    // 6. Generate drafts with past-context awareness
    console.log("Generating drafts...");
    const drafts = await generateAndStoreDrafts(env, db, trends.slice(0, 10));
    console.log(`Generated ${drafts.length} drafts.`);

    if (!drafts.length) {
      console.log("No drafts generated (all filtered as duplicates or generation failed).");
      return;
    }

    // 7. Push drafts to Telegram for approval
    for (const draft of drafts.slice(0, MAX_DRAFTS_PER_TICK)) {
      // Get the draft from DB (it was inserted without telegram_message_id)
      const dbDrafts = await db.getRecentDrafts(drafts.length);
      const dbDraft = dbDrafts.find((d) => d.draft_text === draft.draft_text && d.status === "pending_approval");
      if (!dbDraft) continue;

      const messageId = await sendDraftForApproval(env, dbDraft);
      if (messageId) {
        await db.updateDraftStatus(dbDraft.id, "pending_approval", { telegram_message_id: messageId });
      }
      await sleep(1000); // Small delay between Telegram messages
    }

    console.log("Tick complete. Drafts sent to Telegram for approval.");
  } finally {
    await closeSession(browser);
  }
}

// ─── Executor loop: process approved actions with human-paced delays ───
export async function runExecutor(env: Env, db: SupabaseClient): Promise<void> {
  console.log(`[${new Date().toISOString()}] Executor starting...`);

  const pending = await db.getPendingActions();
  if (!pending.length) {
    console.log("No pending actions.");
    return;
  }

  const { browser, context, page } = await launchSession(true);

  try {
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await sendTelegram(env, b("ALERT: X session expired. Run `npm run login` to re-authenticate."));
      return;
    }

    if (await checkForChallenge(page)) {
      await sendTelegram(env, b("ALERT: X challenge page detected. Stopping executor. Manual intervention required."));
      await db.logHealthEvent(localDate(), "challenge", "Challenge page detected during executor run");
      return;
    }

    for (const action of pending) {
      const draft = await db.getDraftById(action.draft_id);
      if (!draft || draft.status !== "approved") {
        await db.updatePendingAction(action.id, { result: "skipped_challenge", executed_at: new Date().toISOString(), error: "Draft not approved or missing" });
        continue;
      }

      // Check daily caps
      const today = localDate();
      const canPerform = await db.canPerformAction(today, draft.action_type, DAILY_CAPS);
      if (!canPerform) {
        console.log(`Daily cap reached for ${draft.action_type}. Skipping.`);
        await db.updatePendingAction(action.id, { result: "skipped_challenge", executed_at: new Date().toISOString(), error: `Daily cap reached for ${draft.action_type}` });
        continue;
      }

      // Check for near-duplicate
      const hash = hashText(draft.draft_text);
      const existing = await db.getPostByHash(hash);
      if (existing) {
        console.log("Duplicate post detected. Skipping.");
        await db.updatePendingAction(action.id, { result: "skipped_challenge", executed_at: new Date().toISOString(), error: "Duplicate content" });
        continue;
      }

      // Execute with human-paced delay
      const gap = MIN_GAP_SECONDS + Math.random() * JITTER_SECONDS * 2 - JITTER_SECONDS;
      console.log(`Waiting ${Math.round(gap)}s before next action...`);
      await sleep(gap * 1000);

      // Check for challenge before each action
      if (await checkForChallenge(page)) {
        await sendTelegram(env, b("ALERT: X challenge page detected mid-execution. Stopping. Manual intervention required."));
        await db.logHealthEvent(today, "challenge", "Challenge detected mid-execution");
        await db.updatePendingAction(action.id, { result: "skipped_challenge", executed_at: new Date().toISOString(), error: "Challenge page detected" });
        break; // STOP immediately — don't retry
      }

      console.log(`Executing ${draft.action_type}: "${draft.draft_text.slice(0, 50)}..."`);
      const result = await executeAction(page, draft);

      if (result.challenge) {
        await sendTelegram(env, b(`ALERT: Challenge detected after attempting to post. Stopping executor. Error: ${result.error}`));
        await db.logHealthEvent(today, "challenge", result.error ?? "Challenge after post");
        await db.updatePendingAction(action.id, { result: "skipped_challenge", executed_at: new Date().toISOString(), error: result.error });
        break; // STOP immediately
      }

      if (result.success) {
        await db.insertPostedContent({
          text_hash: hash,
          action_type: draft.action_type,
          posted_text: draft.draft_text,
          x_post_url: result.xPostUrl,
        });
        await db.incrementDailyCounter(today, draft.action_type);
        await db.updatePendingAction(action.id, { result: "success", executed_at: new Date().toISOString() });
        await db.updateDraftStatus(draft.id, "approved", {}); // Keep as approved for record

        // Mark quote as used if applicable
        if (draft.quote_text && draft.quote_attributed_to) {
          const quotes = await db.getVerifiedQuotes(100);
          const usedQuote = quotes.find((q) => q.text === draft.quote_text && q.attributed_to === draft.quote_attributed_to);
          if (usedQuote) await db.markQuoteUsed(usedQuote.id);
        }

        console.log("Action executed successfully.");
        await sendTelegram(env, `Posted: "${draft.draft_text.slice(0, 80)}${draft.draft_text.length > 80 ? "..." : ""}"`);
      } else {
        await db.logHealthEvent(today, "failure", result.error ?? "Unknown failure");
        await db.updatePendingAction(action.id, { result: "failed", executed_at: new Date().toISOString(), error: result.error });
        console.error(`Action failed: ${result.error}`);
      }
    }

    console.log("Executor complete.");
  } finally {
    await closeSession(browser);
  }
}

// ─── Telegram bot polling loop ───
export async function runBotPolling(env: Env, db: SupabaseClient): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting Telegram bot polling...`);
  let offset: number | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await import("./telegram").then((m) => m.getUpdates(env, offset, 30));
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          const { handleTelegramUpdate } = await import("./bot");
          await handleTelegramUpdate(env, update, db);
        } catch (error) {
          console.error("Error handling update:", error);
        }
      }
    } catch (error) {
      console.error("Polling error:", error);
      await sleep(5000);
    }
  }
}
