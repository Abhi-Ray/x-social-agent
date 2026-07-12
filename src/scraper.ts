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
  // Step 1: Set the account's content location to India before scraping.
  // X stores this in Settings → Privacy → Content you see → Content location.
  // We navigate there and select India so the explore page shows Indian trends.
  try {
    await page.goto("https://x.com/settings/explore", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);

    // Look for the location selector / "Content location" setting
    // X may show a dropdown or a "Browse locations" link
    const locationDropdown = await page.$('[data-testid="settingsLocationSelector"]') ??
      await page.$('select[aria-label*="location"]') ??
      await page.$('button:has-text("location")') ??
      await page.$('a:has-text("Browse locations")') ??
      await page.$('[aria-label*="location"]');

    if (locationDropdown) {
      await locationDropdown.click();
      await page.waitForTimeout(1000);

      // Search for India in the location picker
      const searchInput = await page.$('input[type="text"]') ?? await page.$('input[placeholder*="Search"]');
      if (searchInput) {
        await searchInput.fill("India");
        await page.waitForTimeout(1000);
        // Click the India result
        const indiaResult = await page.$('[data-testid="TypeaheadUser"]') ??
          await page.$('div:has-text("India")') ??
          await page.$('li:has-text("India")') ??
          await page.$('[role="option"]:has-text("India")') ??
          await page.$('[role="listitem"]:has-text("India")');
        if (indiaResult) {
          await indiaResult.click();
          await page.waitForTimeout(1000);
          // Save changes if there's a save button
          const saveButton = await page.$('button:has-text("Save")') ?? await page.$('[data-testid="settingsSaveButton"]');
          if (saveButton) await saveButton.click();
          await page.waitForTimeout(1000);
          console.log("Set content location to India.");
        }
      }
    }
  } catch {
    // If setting location fails, continue — we'll filter Indian trends below
    console.log("Could not set location via settings, will filter trends by 'India' label.");
  }

  // Step 2: Navigate to the explore/trending page
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

  const allTrends: ScrapedTrend[] = [];

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
        allTrends.push({ topic_text: trendName, category });
      }
    }
  }

  // Fallback: try sidebar trends
  if (!allTrends.length) {
    const sidebarTrends = await page.$$('aside [role="link"], aside a[href*="/search?q="]');
    for (const el of sidebarTrends) {
      const text = await el.textContent().catch(() => null);
      if (text && text.trim() && text.trim().length > 1 && !text.includes("Show more") && !text.includes("What's happening")) {
        allTrends.push({ topic_text: text.trim(), category: null });
      }
    }
  }

  // Filter to Indian trends only.
  // X labels trends with categories like "Trending in India", "Trending in Mumbai", etc.
  // We keep only trends whose category mentions India or an Indian city.
  const indianCities = [
    "india", "mumbai", "delhi", "bangalore", "bengaluru", "hyderabad", "chennai",
    "kolkata", "pune", "ahmedabad", "jaipur", "surat", "lucknow", "kanpur",
    "nagpur", "indore", "bhopal", "patna", "vadodara", "ghaziabad", " ludhiana",
    "agra", "nashik", "faridabad", "meerut", "rajkot", "varanasi", "srinagar",
    "aurangabad", "dhanbad", "amritsar", "noida", "gurugram", "gurgaon",
    "kochi", "coimbatore", "visakhapatnam", "bhubaneswar", "madurai", "mangalore",
  ];

  const isIndianTrend = (category: string | null): boolean => {
    if (!category) return false;
    const lower = category.toLowerCase();
    if (lower.includes("india")) return true;
    return indianCities.some((city) => lower.includes(city));
  };

  let trends = allTrends;
  const indianTrends = allTrends.filter((t) => isIndianTrend(t.category));

  // If we found Indian-labeled trends, use only those.
  // If none have the India label (location setting may have already filtered),
  // fall back to all trends (they're already India-targeted if location was set).
  if (indianTrends.length > 0) {
    trends = indianTrends;
    console.log(`Filtered to ${indianTrends.length} Indian trends (out of ${allTrends.length} total).`);
  } else {
    console.log(`No explicit India labels found, using all ${allTrends.length} trends (location setting should handle filtering).`);
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
