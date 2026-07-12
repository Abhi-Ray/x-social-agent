import "dotenv/config";
import { chromium } from "playwright";

const SESSION_PATH = process.env.STORAGE_STATE_PATH ?? "./storageState.json";

async function main() {
  console.log("Launching browser for manual X/Twitter login...");
  console.log(`Session will be saved to: ${SESSION_PATH}`);
  console.log("");
  console.log("Instructions:");
  console.log("  1. Log in to X/Twitter in the browser window that opens");
  console.log("  2. Once you're on the home timeline, come back here and press Enter");
  console.log("  3. The session will be saved and you can close the browser");
  console.log("");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
  });

  // Anti-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto("https://x.com/login", { waitUntil: "networkidle" });

  console.log("Browser opened. Log in to X/Twitter, then press Enter here.");
  console.log("");

  // Wait for user to press Enter
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  // Save the session
  await context.storageState({ path: SESSION_PATH });
  console.log(`Session saved to ${SESSION_PATH}`);
  console.log("You can now close the browser and run the agent with `npm start` or `npm run dev`.");

  await browser.close();
}

main().catch((error) => {
  console.error("Login script failed:", error);
  process.exit(1);
});
