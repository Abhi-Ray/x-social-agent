import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const SESSION_PATH = process.env.STORAGE_STATE_PATH ?? "./storageState.json";

export async function launchSession(headless = false): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  let context: BrowserContext;
  try {
    context = await browser.newContext({
      storageState: SESSION_PATH,
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
    });
  } catch {
    // No saved session — create fresh context
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
    });
  }

  // Anti-detection: remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: SESSION_PATH });
}

export async function closeSession(browser: Browser): Promise<void> {
  await browser.close();
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto("https://x.com/home", { waitUntil: "networkidle", timeout: 30_000 });
  // Check if we're redirected to login
  const url = page.url();
  if (url.includes("login") || url.includes("i/flow/login")) return false;
  // Check for the compose tweet button or timeline
  try {
    await page.waitForSelector('[data-testid="tweetButtonInline"], [data-testid="primaryColumn"]', { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function checkForChallenge(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("challenge") || url.includes("login") || url.includes("i/flow/login")) return true;
  try {
    const challengeEl = await page.$('[data-testid="ocfEnterTextModal"], .captcha, #arkose-iframe');
    return challengeEl !== null;
  } catch {
    return false;
  }
}
