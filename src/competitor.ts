import type { Page } from "playwright";
import { checkForChallenge } from "./session";
import type { SupabaseClient } from "./supabase";
import type { ViralTemplate } from "./types";

export interface CompetitorPost {
  text: string;
  url: string;
  likes: number;
  retweets: number;
  replies: number;
}

export interface ViralPattern {
  pattern: string;
  template: string;
}

export async function scrapeCompetitorPosts(page: Page, handle: string, limit = 10): Promise<CompetitorPost[]> {
  if (!handle) return [];
  const profileUrl = `https://x.com/${handle.replace(/^@/, "")}`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge during competitor scrape. Stopping.");
  }

  const posts: CompetitorPost[] = [];
  try {
    await page.waitForSelector('article [data-testid="tweetText"]', { timeout: 15_000 });
  } catch {
    return posts;
  }

  const articles = await page.$$('article').catch(() => []);
  for (let i = 0; i < Math.min(articles.length, limit); i++) {
    const article = articles[i]!;
    const text = await article.$eval('[data-testid="tweetText"]', (el) => el.textContent ?? "").catch(() => "");
    const url = await article.$eval("time", (el) => {
      const link = el.parentElement;
      return link?.getAttribute("href") ?? "";
    }).catch(() => "");

    let engagement = { likes: 0, retweets: 0, replies: 0 };
    try {
      const replyLabel = await article.$eval('[data-testid="reply"]', (el) => el.getAttribute("aria-label") ?? "").catch(() => "");
      const retweetLabel = await article.$eval('[data-testid="retweet"]', (el) => el.getAttribute("aria-label") ?? "").catch(() => "");
      const likeLabel = await article.$eval('[data-testid="like"]', (el) => el.getAttribute("aria-label") ?? "").catch(() => "");
      engagement = {
        replies: parseEngagementCount(replyLabel),
        retweets: parseEngagementCount(retweetLabel),
        likes: parseEngagementCount(likeLabel),
      };
    } catch {}

    if (text && text.trim() && url) {
      posts.push({
        text: text.trim(),
        url: url.startsWith("http") ? url : `https://x.com${url}`,
        likes: engagement.likes,
        retweets: engagement.retweets,
        replies: engagement.replies,
      });
    }
  }

  const totalEngagement = (p: CompetitorPost) => p.likes + p.retweets + p.replies;
  return posts.sort((a, b) => totalEngagement(b) - totalEngagement(a));
}

function parseEngagementCount(label: string): number {
  if (!label) return 0;
  const match = label.match(/([\d,.]+K?M?)/i);
  if (!match?.[1]) return 0;
  let str = match[1].replace(/,/g, "");
  if (str.toUpperCase().endsWith("K")) return Math.round(parseFloat(str) * 1000);
  if (str.toUpperCase().endsWith("M")) return Math.round(parseFloat(str) * 1_000_000);
  return parseInt(str, 10) || 0;
}

export function extractViralPattern(postText: string, engagement: { likes: number; retweets: number; replies: number }): ViralPattern {
  const text = postText.trim();
  const lower = text.toLowerCase();
  const totalEngagement = engagement.likes + engagement.retweets + engagement.replies;

  const patterns: Array<{ test: RegExp; pattern: string; template: string }> = [
    { test: /^nobody (is|talks about|wants to tell you|tells you)/i, pattern: "nobody-talks-about", template: "Nobody talks about [TOPIC]" },
    { test: /unpopular opinion/i, pattern: "unpopular-opinion", template: "Unpopular opinion: [HOT TAKE]" },
    { test: /^hot take/i, pattern: "hot-take", template: "Hot take: [HOT TAKE]" },
    { test: /^the (biggest|worst|best|dumbest|craziest) /i, pattern: "superlative-claim", template: "The [SUPERLATIVE] [THING] right now: [SPECIFIC]" },
    { test: /\?$/ , pattern: "question-bait", template: "[PROVOCATIVE QUESTION]?" },
    { test: /^(here's|here is) (why|what|how)/i, pattern: "heres-why", template: "Here's why [CLAIM]: [REASON]" },
    { test: /^\d+\s+(ways|things|reasons|signs|habits|rules|mistakes)/i, pattern: "listicle", template: "[N] [THINGS] that [OUTCOME]" },
    { test: /^stop (doing|using|buying|paying|trusting)/i, pattern: "stop-doing", template: "Stop [DOING X]. [REASON]" },
    { test: /^if you (are|re|do|have|want)/i, pattern: "if-you", template: "If you [CONDITION], [CONSEQUENCE]" },
    { test: /^most people (don't|do not|won't|can't|cannot)/i, pattern: "most-people", template: "Most people don't [DO X]. [INSIGHT]" },
    { test: /^what (if|would happen if)/i, pattern: "what-if", template: "What if [PROVOCATIVE SCENARIO]?" },
    { test: /^the truth about/i, pattern: "truth-about", template: "The truth about [TOPIC]: [REVELATION]" },
    { test: /^everyone (is|thinks|pretends|acts)/i, pattern: "everyone", template: "Everyone [DOES X] but [REALITY]" },
    { test: /^this is (why|how|what)/i, pattern: "this-is-why", template: "This is why [THING] [OUTCOME]" },
    { test: /₹|\$|rs\.|rupees|dollars/i, pattern: "specific-money", template: "[COMPANY/THING] charges [AMOUNT] for [THING] that costs [AMOUNT]" },
    { test: /\b\d{2,}\b/, pattern: "specific-number", template: "[CLAIM with SPECIFIC NUMBER]" },
  ];

  for (const { test, pattern, template } of patterns) {
    if (test.test(lower) || test.test(text)) {
      return { pattern, template };
    }
  }

  if (totalEngagement > 1000) {
    if (text.length < 100) return { pattern: "short-punchy", template: "[SHORT PUNCHY ONE-LINER]" };
    if (text.includes("—") || text.includes(":")) return { pattern: "colon-dash-structure", template: "[SETUP]: [PUNCHLINE]" };
  }

  if (text.split("\n").length >= 3) return { pattern: "multi-line", template: "[LINE 1]\n[LINE 2]\n[PUNCHLINE]" };

  return { pattern: "general-viral", template: "[STRONG OPINION about TOPIC]" };
}

export async function saveCompetitorPost(db: SupabaseClient, handle: string, post: CompetitorPost): Promise<void> {
  await db.insertCompetitorPost({
    handle: handle.replace(/^@/, ""),
    post_text: post.text,
    post_url: post.url,
    likes: post.likes,
    retweets: post.retweets,
    replies: post.replies,
  });
}

export async function saveViralTemplate(
  db: SupabaseClient,
  template: string,
  source: string,
  engagement: { likes: number; retweets: number; replies: number },
): Promise<void> {
  const totalEngagement = engagement.likes + engagement.retweets + engagement.replies;
  await db.insertViralTemplate({
    template,
    source,
    avg_engagement: totalEngagement,
    times_used: 0,
  });
}

export async function getTopViralTemplates(db: SupabaseClient, limit = 10): Promise<ViralTemplate[]> {
  return db.getTopViralTemplates(limit);
}
