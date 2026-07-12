import type { Env, ContextWindow, GeneratedDraft, TrendingTopic, PostedContent, Draft, DailyCounter, VerifiedQuote } from "./types";
import { SupabaseClient } from "./supabase";
import { generateDrafts } from "./openrouter";
import { CONTEXT_POSTS_COUNT, CONTEXT_TRENDS_DAYS, CONTEXT_QUOTES_SAMPLE } from "./config";

export async function buildContextWindow(db: SupabaseClient): Promise<ContextWindow> {
  const [recentPosts, recentTrends, recentDrafts, todayCounters, quotesSample] = await Promise.all([
    db.getRecentPosts(CONTEXT_POSTS_COUNT),
    db.getRecentTrends(CONTEXT_TRENDS_DAYS),
    db.getRecentDrafts(20),
    db.getDailyCounter(getLocalDate()),
    db.getRandomQuotes(CONTEXT_QUOTES_SAMPLE),
  ]);

  return {
    recent_posts: recentPosts,
    recent_trends: recentTrends,
    recent_drafts: recentDrafts,
    today_counters: todayCounters,
    verified_quotes_sample: quotesSample,
    persona_summary: "Billionaire mindset, god complex, sarcastic, atheist, no social order belief, opinionated on all topics, no political bias, factually correct, critical/logical, historical analogies, stoic/Sun Tzu/Indian philosophy references.",
  };
}

function getLocalDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export async function generateAndStoreDrafts(
  env: Env,
  db: SupabaseClient,
  trends: Array<{ topic_text: string; category: string | null }>,
): Promise<GeneratedDraft[]> {
  // Build context window for past-awareness
  const context = await buildContextWindow(db);

  // Generate drafts using OpenRouter
  const drafts = await generateDrafts(env.OPENROUTER_API_KEY, context, trends);

  // Filter out drafts that are too similar to recent posts
  const filtered = drafts.filter((draft) => {
    const similar = context.recent_posts.filter((post) => {
      const sim = wordSimilarity(draft.draft_text, post.posted_text);
      return sim >= 0.6;
    });
    return similar.length === 0;
  });

  // Store drafts in Supabase
  for (const draft of filtered) {
    await db.insertDraft({
      action_type: draft.action_type,
      source_tweet_url: draft.source_tweet_url,
      source_tweet_text: draft.source_tweet_text,
      source_tweet_author: draft.source_tweet_author,
      draft_text: draft.draft_text,
      quote_text: draft.quote_text,
      quote_attributed_to: draft.quote_attributed_to,
      quote_source: draft.quote_source,
      trend_topic: draft.trend_topic,
      telegram_message_id: null,
    });
  }

  return filtered;
}

function wordSimilarity(a: string, b: string): number {
  const na = new Set(a.trim().toLowerCase().split(/\s+/));
  const nb = new Set(b.trim().toLowerCase().split(/\s+/));
  const intersection = [...na].filter((w) => nb.has(w)).length;
  const union = new Set([...na, ...nb]).size;
  return union === 0 ? 0 : intersection / union;
}
