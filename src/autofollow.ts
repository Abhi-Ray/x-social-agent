import type { Page } from "playwright";
import { checkForChallenge } from "./session";
import type { SupabaseClient } from "./supabase";

export type FollowCategory = "tech" | "finance" | "journalism" | "politics" | "philosophy" | "startups";

export interface AccountToFollow {
  handle: string;
  name: string;
  category: string;
  followersCount: number;
}

export interface FollowResult {
  success: boolean;
  error?: string;
}

const SEARCH_QUERIES: Record<FollowCategory, string> = {
  tech: "india tech influencer",
  finance: "india finance influencer",
  journalism: "india journalist",
  politics: "india politics influencer",
  philosophy: "india philosophy influencer",
  startups: "india startup founder",
};

export async function findAccountsToFollow(page: Page, categories: FollowCategory[]): Promise<AccountToFollow[]> {
  const accounts: AccountToFollow[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    const query = SEARCH_QUERIES[category];
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=user`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (await checkForChallenge(page)) {
      throw new Error("CHALLENGE: X is showing a challenge during account search. Stopping.");
    }

    try {
      await page.waitForSelector('article [data-testid="UserCell"], [data-testid="UserCell"]', { timeout: 15_000 });
    } catch {
      continue;
    }

    const userCells = await page.$$('[data-testid="UserCell"]').catch(() => []);
    for (const cell of userCells) {
      const handle = await cell.$eval('a[href^="/"]', (el) => el.getAttribute("href")?.replace("/", "") ?? "").catch(() => "");
      const name = await cell.$eval('a[role="link"] [tabindex], [data-testid="UserCell"] span', (el) => el.textContent ?? "").catch(() => "");
      const followersLabel = await cell.$eval('[data-testid="UserCell"]', (el) => el.textContent ?? "").catch(() => "");
      const followersCount = parseFollowersCount(followersLabel);

      if (handle && !seen.has(handle.toLowerCase())) {
        seen.add(handle.toLowerCase());
        accounts.push({
          handle: handle.replace(/^@/, ""),
          name: String(name).trim(),
          category,
          followersCount,
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 1000));
  }

  return accounts;
}

function parseFollowersCount(text: string): number {
  if (!text) return 0;
  const match = text.match(/([\d,.]+K?M?)\s*followers/i);
  if (!match?.[1]) return 0;
  let str = match[1].replace(/,/g, "");
  if (str.toUpperCase().endsWith("K")) return Math.round(parseFloat(str) * 1000);
  if (str.toUpperCase().endsWith("M")) return Math.round(parseFloat(str) * 1_000_000);
  return parseInt(str, 10) || 0;
}

export async function followAccount(page: Page, handle: string): Promise<FollowResult> {
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (await checkForChallenge(page)) {
      return { success: false, error: "CHALLENGE: X is showing a challenge on profile page." };
    }

    const followButton = await page.$('[data-testid="placementTracking"] [role="button"]:has-text("Follow")') ??
      await page.$('[data-testid="follow"]') ??
      await page.$('button:has-text("Follow")') ??
      await page.$('[role="button"][data-testid$="follow"]');

    if (!followButton) {
      const followingButton = await page.$('[data-testid="placementTracking"] [role="button"]:has-text("Following")') ??
        await page.$('button:has-text("Following")') ??
        await page.$('[data-testid="unfollow"]');
      if (followingButton) return { success: true };
      return { success: false, error: "Could not find follow button on profile." };
    }

    await followButton.click();
    await page.waitForTimeout(2000);

    const followingConfirm = await page.$('[data-testid="placementTracking"] [role="button"]:has-text("Following")') ??
      await page.$('button:has-text("Following")');
    if (followingConfirm) return { success: true };

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function checkFollowBack(page: Page, handle: string): Promise<boolean> {
  try {
    await page.goto(`https://x.com/${handle}/verified_followers`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (await checkForChallenge(page)) return false;

    const userCells = await page.$$('[data-testid="UserCell"]').catch(() => []);
    for (const cell of userCells) {
      const cellHandle = await cell.$eval('a[href^="/"]', (el) => el.getAttribute("href")?.replace("/", "") ?? "").catch(() => "");
      if (cellHandle && cellHandle.toLowerCase() === handle.toLowerCase()) return true;
    }

    await page.goto(`https://x.com/${handle}/followers`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    const followerCells = await page.$$('[data-testid="UserCell"]').catch(() => []);
    for (const cell of followerCells) {
      const cellHandle = await cell.$eval('a[href^="/"]', (el) => el.getAttribute("href")?.replace("/", "") ?? "").catch(() => "");
      if (cellHandle && cellHandle.toLowerCase() === handle.toLowerCase()) return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function unfollowNonFollowers(page: Page, db: SupabaseClient, daysThreshold: number): Promise<number> {
  const threshold = new Date(Date.now() - daysThreshold * 86_400_000).toISOString();
  const accounts = await db.getNonFollowBackAccounts(threshold);

  let unfollowed = 0;
  for (const account of accounts) {
    const result = await unfollowAccount(page, account.handle);
    if (result.success) {
      await db.markAccountUnfollowed(account.id);
      unfollowed++;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 + Math.random() * 2000));
  }

  return unfollowed;
}

async function unfollowAccount(page: Page, handle: string): Promise<FollowResult> {
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (await checkForChallenge(page)) {
      return { success: false, error: "CHALLENGE: X is showing a challenge on profile page." };
    }

    const followingButton = await page.$('[data-testid="placementTracking"] [role="button"]:has-text("Following")') ??
      await page.$('button:has-text("Following")') ??
      await page.$('[data-testid="unfollow"]');

    if (!followingButton) return { success: false, error: "Not following this account." };

    await followingButton.click();
    await page.waitForTimeout(1000);

    const confirmButton = await page.$('[data-testid="confirmationSheetConfirm"]') ??
      await page.$('button:has-text("Unfollow")');
    if (confirmButton) {
      await confirmButton.click();
      await page.waitForTimeout(2000);
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
