import type { Page } from "playwright";
import { checkForChallenge } from "./session";
import { buildSystemPrompt } from "./persona";
import { getFreeModels } from "./openrouter";
import type { SupabaseClient } from "./supabase";
import type { ScrapedFollower } from "./types";

export async function scrapeNewFollowers(page: Page, ownHandle: string): Promise<ScrapedFollower[]> {
  const followersUrl = `https://x.com/${ownHandle}/followers`;
  await page.goto(followersUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge during followers scrape. Stopping.");
  }

  const followers: ScrapedFollower[] = [];
  try {
    await page.waitForSelector('[data-testid="UserCell"]', { timeout: 15_000 });
  } catch {
    return followers;
  }

  const cells = await page.$$('[data-testid="UserCell"]').catch(() => []);
  for (const cell of cells) {
    const handle = await cell.$eval('a[href^="/"]', (el) => {
      const href = el.getAttribute("href") ?? "";
      return href.replace("/", "");
    }).catch(() => "");
    const name = await cell.$eval('a[role="link"] span, [data-testid="UserCell"] > div > div > span', (el) => el.textContent ?? "").catch(() => "");
    if (handle && handle !== ownHandle) {
      followers.push({ handle, name: name.trim() });
    }
  }

  const seen = new Set<string>();
  return followers.filter((f) => {
    if (seen.has(f.handle)) return false;
    seen.add(f.handle);
    return true;
  });
}

export async function sendDM(page: Page, handle: string, message: string): Promise<{ success: boolean; error: string | null }> {
  try {
    const dmUrl = `https://x.com/messages/compose?recipient_id=${handle}`;
    await page.goto(dmUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);

    if (await checkForChallenge(page)) {
      return { success: false, error: "CHALLENGE: X is showing a challenge during DM compose. Stopping." };
    }

    const editor = await page.$('[data-testid="dmComposerTextInput"] [contenteditable="true"], div[contenteditable="true"][role="textbox"]')
      .catch(() => null);
    if (!editor) {
      return { success: false, error: "DM composer input not found" };
    }

    await editor.click();
    await page.waitForTimeout(500);
    await editor.fill(message);
    await page.waitForTimeout(500);

    const sendButton = await page.$('[data-testid="dmComposerSendButton"], button:has-text("Send")').catch(() => null);
    if (!sendButton) {
      return { success: false, error: "DM send button not found" };
    }

    await sendButton.click();
    await page.waitForTimeout(2000);

    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error sending DM" };
  }
}

export async function generateWelcomeMessage(apiKey: string, followerHandle: string): Promise<string> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = `A new follower just followed you on X/Twitter. Their handle is @${followerHandle}.

Write a short, witty welcome DM to send them. Rules:
- Keep it under 200 characters. Short is better.
- Sound like a real person, not a bot. No spam, no links, no "thanks for following" template energy.
- Be witty, confident, a little cheeky — on-brand with the billionaire persona.
- Make them feel like they made a good decision following you.
- Do NOT ask them to do anything (no "check out my profile", no "retweet this").
- One sentence, maybe two. Casual.
- No emoji unless it's the punchline.

Return ONLY the DM text. No JSON, no quotes, no explanation. Just the message.`;

  for (const model of models) {
    console.log(`[AutoDM] Using model: ${model}`);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://github.com/Abhi-Ray/x-social-agent",
        "x-title": "X Social Agent",
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 200,
        reasoning: { effort: "none" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (response.status === 402 || response.status === 429 || response.status >= 500) continue;
    if (!response.ok) continue;

    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      continue;
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) continue;

    const cleaned = content
      .replace(/^["']|["']$/g, "")
      .replace(/^```[\s\S]*?\n/, "")
      .replace(/\n```$/, "")
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 500) return cleaned;
  }

  return `Welcome to the inner circle, @${followerHandle}. Good instincts. Let's see if you can keep up.`;
}

export async function processNewFollowers(db: SupabaseClient, page: Page, ownHandle: string, apiKey: string): Promise<number> {
  const scraped = await scrapeNewFollowers(page, ownHandle);
  if (!scraped.length) return 0;

  const knownHandles = await db.getKnownFollowerHandles(500);
  const newFollowers = scraped.filter((f) => !knownHandles.has(f.handle));
  if (!newFollowers.length) return 0;

  await db.insertNewFollowers(newFollowers);

  const pending = await db.getNewFollowersWithoutDM(50);
  if (!pending.length) return 0;

  let sentCount = 0;
  for (const follower of pending) {
    const message = await generateWelcomeMessage(apiKey, follower.handle);
    const result = await sendDM(page, follower.handle, message);
    if (result.success) {
      await db.markFollowerDMSent(follower.id);
      sentCount++;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      console.log(`[AutoDM] Failed to DM @${follower.handle}: ${result.error}`);
    }
  }

  return sentCount;
}
