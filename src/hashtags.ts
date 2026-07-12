import type { SupabaseClient } from "./supabase";
import type { HashtagStat, PostedContent } from "./types";

export function extractHashtags(postText: string): string[] {
  const matches = postText.match(/#[\w]+/g);
  if (!matches) return [];
  return matches.map((tag) => tag.toLowerCase());
}

export async function recordHashtagPerformance(
  db: SupabaseClient,
  hashtag: string,
  postUrl: string | null,
  engagement: number,
): Promise<void> {
  await db.insertHashtagPerformance({
    hashtag: hashtag.toLowerCase(),
    post_url: postUrl,
    engagement,
  });
}

export async function getTopHashtags(db: SupabaseClient, limit = 10): Promise<HashtagStat[]> {
  return db.getTopHashtags(limit);
}

export async function suggestHashtags(db: SupabaseClient, topic: string): Promise<string[]> {
  const topHashtags = await db.getTopHashtags(50);
  if (!topHashtags.length) return [];

  const topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored: Array<{ hashtag: string; score: number }> = [];

  for (const stat of topHashtags) {
    const tagWords = stat.hashtag.replace(/^#/, "").split(/(?=[A-Z])|_/).map((w) => w.toLowerCase());
    const overlap = topicWords.filter((w) => tagWords.some((tw) => tw.includes(w) || w.includes(tw))).length;
    if (overlap === 0) continue;

    const relevanceScore = overlap / topicWords.length;
    const performanceScore = Math.min(stat.avg_engagement / 100, 1);
    const sampleScore = Math.min(stat.total_posts / 5, 1);
    const score = 0.5 * relevanceScore + 0.3 * performanceScore + 0.2 * sampleScore;

    scored.push({ hashtag: stat.hashtag, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((s) => s.hashtag);
}

export async function updateHashtagPerformanceFromPosts(
  db: SupabaseClient,
  recentPosts: PostedContent[],
): Promise<void> {
  for (const post of recentPosts) {
    const hashtags = extractHashtags(post.posted_text);
    if (!hashtags.length) continue;

    const engagement = (post.engagement_likes ?? 0) + (post.engagement_retweets ?? 0) + (post.engagement_replies ?? 0);
    for (const hashtag of hashtags) {
      await recordHashtagPerformance(db, hashtag, post.x_post_url, engagement);
    }
  }
}
