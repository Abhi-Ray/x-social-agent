import type { Page } from "playwright";
import { checkForChallenge } from "./session";

export interface ScrapedTrend {
  topic_text: string;
  category: string | null;
}

export interface ScrapedTweet {
  url: string;
  text: string;
  author: string;
  authorHandle: string;
}

export async function scrapeTrending(page: Page): Promise<ScrapedTrend[]> {
  // X's trending page shows trends based on account location settings.
  // We try the explore page first, then fall back to the home sidebar.
  // The trends shown depend on what X has configured for this account.
  // To get Indian trends, the X account's location should be set to India
  // in Settings → Privacy → Content location.
  await page.goto("https://x.com/explore/tabs/trending", { waitUntil: "domcontentloaded", timeout: 30_000 });

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge/login page during trending scrape. Stopping.");
  }

  // Wait for trending items to load
  try {
    await page.waitForSelector('[data-testid="trend"]', { timeout: 15_000 });
  } catch {
    // Fallback: try the sidebar trends on home page
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('aside[aria-label="Trends"]', { timeout: 15_000 }).catch(() => {});
  }

  const trends: ScrapedTrend[] = [];

  // Try data-testid="trend" elements
  const trendElements = await page.$$('[data-testid="trend"]');
  for (const el of trendElements) {
    const text = await el.textContent().catch(() => null);
    if (text && text.trim()) {
      // Clean up the text — trends have category + name + post count
      const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      // The trend name is usually the second line (first is category like "Trending in India")
      const trendName = lines.length >= 2 ? lines[1] : lines[0] ?? text.trim();
      const category = lines.length >= 2 ? (lines[0] ?? null) : null;
      if (trendName && trendName.length > 1 && !trendName.includes("Show more")) {
        trends.push({ topic_text: trendName, category });
      }
    }
  }

  // Fallback: try sidebar trends
  if (!trends.length) {
    const sidebarTrends = await page.$$('aside [role="link"], aside a[href*="/search?q="]');
    for (const el of sidebarTrends) {
      const text = await el.textContent().catch(() => null);
      if (text && text.trim() && text.trim().length > 1 && !text.includes("Show more") && !text.includes("What's happening")) {
        trends.push({ topic_text: text.trim(), category: null });
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return trends.filter((t) => {
    const key = t.topic_text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

export async function scrapeTimelineTweets(page: Page, limit = 10): Promise<ScrapedTweet[]> {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30_000 });

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge/login page during timeline scrape. Stopping.");
  }

  const tweets: ScrapedTweet[] = [];
  try {
    await page.waitForSelector('[data-testid="tweetText"]', { timeout: 15_000 });
  } catch {
    return tweets;
  }

  const tweetElements = await page.$$('[data-testid="tweetText"]').catch(() => []);
  for (let i = 0; i < Math.min(tweetElements.length, limit); i++) {
    const el = tweetElements[i]!;
    const text = await el.textContent().catch(() => "");
    // Try to find the parent article to get author info
    const parent = await el.evaluateHandle((node) => node.closest("article"));
    const author = await parent.evaluate((node) => {
      const el = node?.querySelector('a[role="link"] [tabindex]');
      return el?.textContent ?? "";
    }).catch(() => "");
    const authorHandle = await parent.evaluate((node) => {
      const link = node?.querySelector('a[href^="/"]');
      const href = link?.getAttribute("href") ?? "";
      return href.replace("/", "");
    }).catch(() => "");

    if (text && text.trim()) {
      tweets.push({
        url: "", // Would need to extract from the tweet's time element's parent link
        text: text.trim(),
        author: String(author),
        authorHandle: String(authorHandle),
      });
    }
  }

  return tweets;
}

export async function scrapeOwnProfile(page: Page, handle: string, limit = 20): Promise<ScrapedTweet[]> {
  if (!handle) return [];
  await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 30_000 });

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge/login page during profile scrape. Stopping.");
  }

  const tweets: ScrapedTweet[] = [];
  try {
    await page.waitForSelector('[data-testid="tweetText"]', { timeout: 15_000 });
  } catch {
    return tweets;
  }

  const tweetElements = await page.$$('[data-testid="tweetText"]').catch(() => []);
  for (let i = 0; i < Math.min(tweetElements.length, limit); i++) {
    const el = tweetElements[i]!;
    const text = await el.textContent().catch(() => "");
    // Try to get tweet URL from the time element
    const url = await el.evaluate((node) => {
      const article = node?.closest("article");
      const timeLink = article?.querySelector("time")?.parentElement;
      return timeLink?.getAttribute("href") ?? "";
    }).catch(() => "");

    if (text && text.trim()) {
      tweets.push({
        url: url ? `https://x.com${url}` : "",
        text: text.trim(),
        author: handle,
        authorHandle: handle,
      });
    }
  }

  return tweets;
}
