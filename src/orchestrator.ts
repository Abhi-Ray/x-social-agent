import type { Env } from "./types";
import { SupabaseClient } from "./supabase";
import { launchSession, closeSession, isLoggedIn, checkForChallenge } from "./session";
import { scrapeTrending, scrapeTrendTopTweets } from "./scraper";
import { generateAndStoreDrafts } from "./generator";
import { sendDraftForApproval, sendTelegram, b } from "./telegram";
import { executeAction } from "./executor";
import { scrapeAllEngagement } from "./engagement";
import { findAccountsToFollow, followAccount, unfollowNonFollowers, type FollowCategory } from "./autofollow";
import { isGoodTimeToPost, updateEngagementByHour, getBestPostingHours } from "./besttime";
import { analyzePostReplies } from "./sentiment";
import { scrapeCompetitorPosts, extractViralPattern, saveCompetitorPost, saveViralTemplate, getTopViralTemplates } from "./competitor";
import { shouldGenerateImage, generateImagePrompt, generateImage } from "./images";
import { shouldPostInHindi, generateHindiPost } from "./hindi";
import { scrapeEmergingTopics, predictAndStore, checkPredictionsTrended, getPredictedTopicsToPost } from "./trendpredict";
import { processNewFollowers } from "./autodm";
import { suggestHashtags, updateHashtagPerformanceFromPosts } from "./hashtags";
import { autoReplyToMentions } from "./mentions";
import { crossPostAll, shouldCrossPost } from "./crosspost";
import { pickNextPillar, getPillarInstructions, logPillarUse } from "./pillars";
import { shouldUseTemplate, getUnusedTemplate, fillTemplate } from "./viraltemplates";
import { DAILY_CAPS, MIN_GAP_SECONDS, JITTER_SECONDS, MAX_DRAFTS_PER_TICK, localDate, sleep, hashText, isQuietHours, getISTHour } from "./config";
import type { ActionType } from "./types";

// Indian competitor accounts to learn from (viral Indian X accounts)
const COMPETITOR_HANDLES = [
  "peakbengali", "bababoro", "GabbbarSingh", "harryistired", "Being_Humor",
  "RoflGandhi_", "shubham_1107", "KarthikMudgal", "GabbarSays", "baba__g",
];

// Indian influencer categories for auto-follow
const INFLUENCER_CATEGORIES = ["tech", "finance", "journalism", "politics", "startups"];

// ─── Main tick: scrape trends → generate drafts → push to Telegram ───
export async function runTick(env: Env, db: SupabaseClient): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting tick... (IST hour: ${getISTHour()})`);

  // Quiet hours: 12 AM to 7 AM IST — skip tick entirely
  if (isQuietHours()) {
    console.log(`Quiet hours (12 AM - 7 AM IST). Skipping tick. Current IST hour: ${getISTHour()}`);
    return;
  }

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

    // 5b. Scrape top viral tweets for the top 3 trends — for reply drafts
    // This is the key growth hack: replying to viral tweets gets you discovered
    console.log("Scraping viral tweets for reply opportunities...");
    const viralTweets: Array<{ trend: string; tweet: { url: string; text: string; author: string; authorHandle: string; engagement?: { likes: number; retweets: number; replies: number } } }> = [];
    for (const trend of trends.slice(0, 3)) {
      try {
        const topTweets = await scrapeTrendTopTweets(page, trend.topic_text, 3);
        if (topTweets.length) {
          // Pick the most engaging tweet
          const best = topTweets[0]!;
          // Only reply to tweets with meaningful engagement (100+ total engagement)
          const totalEng = (best.engagement?.likes ?? 0) + (best.engagement?.retweets ?? 0) + (best.engagement?.replies ?? 0);
          if (totalEng >= 100) {
            viralTweets.push({ trend: trend.topic_text, tweet: best });
            console.log(`  Found viral tweet for "${trend.topic_text}": ${best.authorHandle} (${totalEng} engagement)`);
          }
        }
      } catch (e) {
        console.log(`  Failed to scrape tweets for "${trend.topic_text}": ${e instanceof Error ? e.message : e}`);
      }
      await sleep(2000 + Math.random() * 1000);
    }

    // 6. Generate drafts with past-context awareness + viral reply targets
    // Pick a content pillar for this tick (topic rotation)
    let pillarInstruction = "";
    try {
      const pillar = await pickNextPillar(db);
      pillarInstruction = getPillarInstructions(pillar);
      console.log(`Content pillar for this tick: ${pillar}`);
    } catch (e) {
      console.log(`Pillar selection failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Check if we should generate a Hindi/Hinglish post (every 4th post)
    let hindiPost: { text: string; script: string; topic: string } | null = null;
    try {
      if (await shouldPostInHindi(db, 10)) {
        const topTrend = trends[0]?.topic_text ?? "India";
        hindiPost = await generateHindiPost(env.OPENROUTER_API_KEY, await import("./generator").then(m => m.buildContextWindow(db)), topTrend);
        console.log(`Generated Hindi post (${hindiPost.script}): ${hindiPost.text.slice(0, 60)}...`);
      }
    } catch (e) {
      console.log(`Hindi generation failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Check if we should use a viral template
    let templatePost: string | null = null;
    try {
      if (await shouldUseTemplate(db)) {
        const template = await getUnusedTemplate(db);
        if (template) {
          templatePost = await fillTemplate(template.template, { trend: trends[0]?.topic_text ?? "India" });
          console.log(`Generated viral template post: ${templatePost.slice(0, 60)}...`);
        }
      }
    } catch (e) {
      console.log(`Viral template failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Trend prediction — check if previous predictions came true
    try {
      const trendedCount = await checkPredictionsTrended(page, db);
      if (trendedCount > 0) console.log(`Trend predictions: ${trendedCount} predictions came true.`);
      // Store new predictions
      const emerging = await scrapeEmergingTopics(page, db);
      if (emerging.length) {
        await predictAndStore(db, emerging);
        console.log(`Stored ${emerging.length} trend predictions.`);
      }
    } catch (e) {
      console.log(`Trend prediction failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Auto-reply to mentions (every tick)
    try {
      const replyCount = await autoReplyToMentions(db, page, env.X_HANDLE, env.OPENROUTER_API_KEY);
      if (replyCount > 0) {
        console.log(`Auto-replied to ${replyCount} mentions.`);
        await sendTelegram(env, b(`Replied to ${replyCount} mentions on X.`));
      }
    } catch (e) {
      console.log(`Mention reply failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Hashtag performance update
    try {
      const recentPosts = await db.getRecentPosts(20);
      await updateHashtagPerformanceFromPosts(db, recentPosts);
    } catch (e) {
      console.log(`Hashtag update failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Competitor cloning — scrape 1 competitor per tick (rotate)
    try {
      const competitorHandle = COMPETITOR_HANDLES[Math.floor(Math.random() * COMPETITOR_HANDLES.length)]!;
      const competitorPosts = await scrapeCompetitorPosts(page, competitorHandle, 5);
      for (const post of competitorPosts) {
        await saveCompetitorPost(db, competitorHandle, post);
        const eng = { likes: post.likes, retweets: post.retweets, replies: post.replies };
        const { template } = extractViralPattern(post.text, eng);
        if (template) await saveViralTemplate(db, template, competitorHandle, eng);
      }
      if (competitorPosts.length) console.log(`Cloned ${competitorPosts.length} posts from @${competitorHandle}.`);
    } catch (e) {
      console.log(`Competitor cloning failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    console.log("Generating drafts...");
    const drafts = await generateAndStoreDrafts(env, db, trends.slice(0, 10), viralTweets);
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

    // Send Hindi post to Telegram if generated
    if (hindiPost) {
      try {
        const dbDrafts = await db.getRecentDrafts(1);
        const hindiDraft = {
          id: "",
          action_type: "original_post" as ActionType,
          source_tweet_url: null,
          source_tweet_text: null,
          source_tweet_author: null,
          draft_text: hindiPost.text,
          quote_text: null,
          quote_attributed_to: null,
          quote_source: null,
          trend_topic: hindiPost.topic,
          status: "pending_approval" as const,
          telegram_message_id: null,
          created_at: new Date().toISOString(),
        };
        await db.insertDraft(hindiDraft);
        const freshDrafts = await db.getRecentDrafts(5);
        const inserted = freshDrafts.find((d) => d.draft_text === hindiPost.text && d.status === "pending_approval");
        if (inserted) {
          const msgId = await sendDraftForApproval(env, { ...inserted, draft_text: `[${hindiPost.script.toUpperCase()}] ${inserted.draft_text}` });
          if (msgId) await db.updateDraftStatus(inserted.id, "pending_approval", { telegram_message_id: msgId });
        }
      } catch (e) {
        console.log(`Hindi post delivery failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Send viral template post to Telegram if generated
    if (templatePost) {
      try {
        const templateDraft = {
          id: "",
          action_type: "original_post" as ActionType,
          source_tweet_url: null,
          source_tweet_text: null,
          source_tweet_author: null,
          draft_text: templatePost,
          quote_text: null,
          quote_attributed_to: null,
          quote_source: null,
          trend_topic: "viral_template",
          status: "pending_approval" as const,
          telegram_message_id: null,
          created_at: new Date().toISOString(),
        };
        await db.insertDraft(templateDraft);
        const freshDrafts = await db.getRecentDrafts(5);
        const inserted = freshDrafts.find((d) => d.draft_text === templatePost && d.status === "pending_approval");
        if (inserted) {
          const msgId = await sendDraftForApproval(env, { ...inserted, draft_text: `[VIRAL TEMPLATE] ${inserted.draft_text}` });
          if (msgId) await db.updateDraftStatus(inserted.id, "pending_approval", { telegram_message_id: msgId });
        }
      } catch (e) {
        console.log(`Viral template delivery failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Auto-follow: find and follow 1-2 Indian influencers per tick
    try {
      const accountsToFollow = await findAccountsToFollow(page, [INFLUENCER_CATEGORIES[Math.floor(Math.random() * INFLUENCER_CATEGORIES.length)] as FollowCategory]);
      let followed = 0;
      for (const account of accountsToFollow.slice(0, 2)) {
        const result = await followAccount(page, account.handle);
        if (result.success) {
          await db.insertFollowedAccount({ handle: account.handle, name: account.name, category: account.category, followers_count: account.followersCount });
          followed++;
          await sleep(3000 + Math.random() * 2000);
        }
      }
      if (followed > 0) console.log(`Auto-followed ${followed} accounts.`);
    } catch (e) {
      console.log(`Auto-follow failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Auto-DM new followers
    try {
      const dmCount = await processNewFollowers(db, page, env.X_HANDLE, env.OPENROUTER_API_KEY);
      if (dmCount > 0) {
        console.log(`Sent ${dmCount} welcome DMs to new followers.`);
        await sendTelegram(env, b(`Sent ${dmCount} welcome DMs to new followers.`));
      }
    } catch (e) {
      console.log(`Auto-DM failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Sentiment analysis on recent posts
    try {
      const recentPosts = await db.getRecentPosts(5);
      for (const post of recentPosts) {
        if (post.x_post_url) {
          await analyzePostReplies(db, page, post.x_post_url);
          await sleep(2000);
        }
      }
    } catch (e) {
      console.log(`Sentiment analysis failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    console.log("Tick complete. Drafts sent to Telegram for approval.");
  } finally {
    await closeSession(browser);
  }
}

// ─── Executor loop: process approved actions with human-paced delays ───
export async function runExecutor(env: Env, db: SupabaseClient): Promise<void> {
  console.log(`[${new Date().toISOString()}] Executor starting... (IST hour: ${getISTHour()})`);

  // Quiet hours: don't post during 12 AM - 7 AM IST
  if (isQuietHours()) {
    console.log(`Quiet hours (12 AM - 7 AM IST). Executor paused. Pending actions will execute after 7 AM.`);
    return;
  }

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

        // Log content pillar use
        try {
          const pillar = await pickNextPillar(db);
          await logPillarUse(db, pillar, result.xPostUrl ?? undefined);
        } catch {}

        // Record engagement by hour for best-time-to-post AI
        try {
          await updateEngagementByHour(db, getISTHour(), 0);
        } catch {}

        // Cross-post to Threads/LinkedIn if configured (only for original posts)
        if (draft.action_type === "original_post") {
          try {
            await crossPostAll(draft.draft_text, undefined, db, draft.action_type, result.xPostUrl ?? undefined);
          } catch (e) {
            console.log(`Cross-post failed (non-fatal): ${e instanceof Error ? e.message : e}`);
          }
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

// ─── Engagement tracker: scrape likes/RTs/replies on recent posts ───
export async function runEngagementCheck(env: Env, db: SupabaseClient): Promise<void> {
  const postsToCheck = await db.getPostsForEngagementCheck(15);
  if (!postsToCheck.length) {
    console.log("No posts to check engagement for.");
    return;
  }

  console.log(`[${new Date().toISOString()}] Checking engagement on ${postsToCheck.length} posts...`);
  const { browser, page } = await launchSession(true);

  try {
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      console.log("Session expired, skipping engagement check.");
      return;
    }

    if (await checkForChallenge(page)) {
      console.log("Challenge detected, skipping engagement check.");
      return;
    }

    const results = await scrapeAllEngagement(page, postsToCheck);
    for (const { id, metrics } of results) {
      await db.updateEngagement(id, {
        engagement_likes: metrics.likes,
        engagement_retweets: metrics.retweets,
        engagement_replies: metrics.replies,
      });
    }
    console.log(`Engagement updated for ${results.length} posts.`);

    // Send a weekly engagement summary if it's been a while
    const totalLikes = results.reduce((sum, r) => sum + r.metrics.likes, 0);
    const totalRTs = results.reduce((sum, r) => sum + r.metrics.retweets, 0);
    if (results.length >= 5) {
      const topPost = results.reduce((best, r) => {
        const score = r.metrics.likes + r.metrics.retweets + r.metrics.replies;
        const bestScore = best.metrics.likes + best.metrics.retweets + best.metrics.replies;
        return score > bestScore ? r : best;
      }, results[0]!);
      const topPostData = postsToCheck.find((p) => p.id === topPost.id);
      if (topPostData) {
        await sendTelegram(env, [
          b("Engagement Update"),
          "",
          `Checked ${results.length} recent posts.`,
          `Total: ${totalLikes} likes, ${totalRTs} retweets`,
          "",
          b("Top performer:"),
          `"${topPostData.posted_text.slice(0, 100)}..."`,
          `${topPost.metrics.likes} likes, ${topPost.metrics.retweets} RTs, ${topPost.metrics.replies} replies`,
        ].join("\n"));
      }
    }
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
