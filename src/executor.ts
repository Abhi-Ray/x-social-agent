import type { Page } from "playwright";
import type { Draft, ActionType } from "./types";
import { checkForChallenge } from "./session";
import { sleep } from "./config";

export interface ExecutionResult {
  success: boolean;
  xPostUrl: string | null;
  error: string | null;
  challenge: boolean;
}

export async function executeAction(page: Page, draft: Draft): Promise<ExecutionResult> {
  try {
    if (draft.action_type === "original_post") {
      return await postOriginal(page, draft.draft_text);
    }
    if (draft.action_type === "reply" && draft.source_tweet_url) {
      return await postReply(page, draft.source_tweet_url, draft.draft_text);
    }
    if (draft.action_type === "retweet_comment" && draft.source_tweet_url) {
      return await postRetweetWithComment(page, draft.source_tweet_url, draft.draft_text);
    }
    if (draft.action_type === "mention") {
      // Mentions are just posts that include @handle — treat like original post
      return await postOriginal(page, draft.draft_text);
    }
    return { success: false, xPostUrl: null, error: `Unknown action type or missing source URL: ${draft.action_type}`, challenge: false };
  } catch (error) {
    const isChallenge = await checkForChallenge(page);
    return {
      success: false,
      xPostUrl: null,
      error: error instanceof Error ? error.message : String(error),
      challenge: isChallenge,
    };
  }
}

async function postOriginal(page: Page, text: string): Promise<ExecutionResult> {
  await page.goto("https://x.com/compose/post", { waitUntil: "networkidle", timeout: 30_000 });

  if (await checkForChallenge(page)) {
    return { success: false, xPostUrl: null, error: "Challenge page detected", challenge: true };
  }

  // Wait for the compose dialog
  try {
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
  } catch {
    // Fallback: go to home and use the inline composer
    await page.goto("https://x.com/home", { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
  }

  // Type the text
  await page.click('[data-testid="tweetTextarea_0"]');
  await page.fill('[data-testid="tweetTextarea_0"]', text);
  await sleep(500 + Math.random() * 1000);

  // Click post button
  await page.click('[data-testid="tweetButton"]');
  await sleep(2000 + Math.random() * 2000);

  // Check for challenge after posting
  if (await checkForChallenge(page)) {
    return { success: false, xPostUrl: null, error: "Challenge page detected after post", challenge: true };
  }

  // Try to capture the URL of the posted tweet
  const xPostUrl = await captureLatestTweetUrl(page);

  return { success: true, xPostUrl, error: null, challenge: false };
}

async function postReply(page: Page, tweetUrl: string, text: string): Promise<ExecutionResult> {
  await page.goto(tweetUrl, { waitUntil: "networkidle", timeout: 30_000 });

  if (await checkForChallenge(page)) {
    return { success: false, xPostUrl: null, error: "Challenge page detected", challenge: true };
  }

  // Wait for the reply box
  try {
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
  } catch {
    return { success: false, xPostUrl: null, error: "Reply box not found", challenge: false };
  }

  await page.click('[data-testid="tweetTextarea_0"]');
  await page.fill('[data-testid="tweetTextarea_0"]', text);
  await sleep(500 + Math.random() * 1000);

  // Click reply button
  await page.click('[data-testid="tweetButtonInline"]');
  await sleep(2000 + Math.random() * 2000);

  if (await checkForChallenge(page)) {
    return { success: false, xPostUrl: null, error: "Challenge page detected after reply", challenge: true };
  }

  return { success: true, xPostUrl: tweetUrl, error: null, challenge: false };
}

async function postRetweetWithComment(page: Page, tweetUrl: string, text: string): Promise<ExecutionResult> {
  await page.goto(tweetUrl, { waitUntil: "networkidle", timeout: 30_000 });

  if (await checkForChallenge(page)) {
    return { success: false, xPostUrl: null, error: "Challenge page detected", challenge: true };
  }

  // Click the retweet button
  try {
    await page.waitForSelector('[data-testid="retweet"]', { timeout: 10_000 });
    await page.click('[data-testid="retweet"]');
    await sleep(1000);

    // Click "Quote" option
    await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 5000 }).catch(() => {});
    // Look for the "Quote" option in the dropdown
    const quoteButton = await page.$('text="Quote"') ?? await page.$('[role="menuitem"]:has-text("Quote")');
    if (quoteButton) {
      await quoteButton.click();
      await sleep(1000);
    } else {
      // If no quote option, try the retweet with comment dialog
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 5000 }).catch(() => {});
    }
  } catch {
    return { success: false, xPostUrl: null, error: "Retweet button not found", challenge: false };
  }

  // Type the comment
  try {
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 5000 });
  } catch {
    return { success: false, xPostUrl: null, error: "Quote tweet textarea not found", challenge: false };
  }

  await page.click('[data-testid="tweetTextarea_0"]');
  await page.fill('[data-testid="tweetTextarea_0"]', text);
  await sleep(500 + Math.random() * 1000);

  // Click the post/retweet button
  await page.click('[data-testid="tweetButton"]').catch(async () => {
    await page.click('[data-testid="retweetBtnConfirm"]').catch(() => {});
  });
  await sleep(2000 + Math.random() * 2000);

  if (await checkForChallenge(page)) {
    return { success: false, xPostUrl: null, error: "Challenge page detected after retweet", challenge: true };
  }

  const xPostUrl = await captureLatestTweetUrl(page);
  return { success: true, xPostUrl, error: null, challenge: false };
}

async function captureLatestTweetUrl(page: Page): Promise<string | null> {
  try {
    // Navigate to own profile to get the latest tweet URL
    // Or try to capture from the toast notification
    const toast = await page.$('[data-testid="toast"]');
    if (toast) {
      const link = await toast.$("a[href]");
      if (link) {
        const href = await link.getAttribute("href");
        if (href) return href.startsWith("http") ? href : `https://x.com${href}`;
      }
    }
  } catch {
    // Ignore — URL capture is best-effort
  }
  return null;
}
