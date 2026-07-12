import type { Page } from "playwright";
import { checkForChallenge } from "./session";

export interface EngagementMetrics {
  likes: number;
  retweets: number;
  replies: number;
  views: number | null;
}

export async function scrapeEngagement(page: Page, postUrl: string): Promise<EngagementMetrics | null> {
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (await checkForChallenge(page)) return null;

    // Wait for the tweet to load
    try {
      await page.waitForSelector('article [data-testid="tweetText"]', { timeout: 10_000 });
    } catch {
      return null; // Tweet might be deleted or unavailable
    }

    // Extract engagement metrics from the tweet's action bar
    const metrics: EngagementMetrics = { likes: 0, retweets: 0, replies: 0, views: null };

    // Replies
    try {
      const replyButton = await page.$('[data-testid="reply"]');
      if (replyButton) {
        const ariaLabel = await replyButton.getAttribute("aria-label");
        if (ariaLabel) metrics.replies = parseCount(ariaLabel);
      }
    } catch {}

    // Retweets
    try {
      const retweetButton = await page.$('[data-testid="retweet"]');
      if (retweetButton) {
        const ariaLabel = await retweetButton.getAttribute("aria-label");
        if (ariaLabel) metrics.retweets = parseCount(ariaLabel);
      }
    } catch {}

    // Likes
    try {
      const likeButton = await page.$('[data-testid="like"]');
      if (likeButton) {
        const ariaLabel = await likeButton.getAttribute("aria-label");
        if (ariaLabel) metrics.likes = parseCount(ariaLabel);
      }
    } catch {}

    // Views (analytics link)
    try {
      const analyticsLink = await page.$('a[href*="/analytics"]');
      if (analyticsLink) {
        const ariaLabel = await analyticsLink.getAttribute("aria-label");
        if (ariaLabel) metrics.views = parseCount(ariaLabel);
      }
    } catch {}

    return metrics;
  } catch {
    return null;
  }
}

function parseCount(label: string): number {
  // X uses aria-labels like "123 replies", "1.2K likes", "45 reposts"
  const match = label.match(/([\d,.]+K?)\s/i) ?? label.match(/([\d,.]+K?)/i);
  if (!match?.[1]) return 0;
  let str = match[1].replace(/,/g, "");
  if (str.toUpperCase().endsWith("K")) {
    return Math.round(parseFloat(str) * 1000);
  }
  if (str.toUpperCase().endsWith("M")) {
    return Math.round(parseFloat(str) * 1_000_000);
  }
  return parseInt(str, 10) || 0;
}

// Scrape engagement for all recent posts that have a URL
export async function scrapeAllEngagement(
  page: Page,
  posts: Array<{ id: string; x_post_url: string | null }>,
): Promise<Array<{ id: string; metrics: EngagementMetrics }>> {
  const results: Array<{ id: string; metrics: EngagementMetrics }> = [];
  for (const post of posts) {
    if (!post.x_post_url) continue;
    const metrics = await scrapeEngagement(page, post.x_post_url);
    if (metrics) results.push({ id: post.id, metrics });
    // Human-paced delay between scrapes
    await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 1000));
  }
  return results;
}
