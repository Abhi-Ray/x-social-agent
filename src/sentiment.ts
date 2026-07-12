import type { Page } from "playwright";
import { checkForChallenge } from "./session";
import type { SupabaseClient } from "./supabase";

export interface ScrapedReply {
  text: string;
  author: string;
}

export interface SentimentResult {
  sentiment: "positive" | "negative" | "neutral";
  score: number;
}

export interface SentimentSummary {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

const POSITIVE_WORDS = new Set([
  "good", "great", "awesome", "amazing", "excellent", "love", "loved", "best",
  "fantastic", "wonderful", "brilliant", "superb", "nice", "happy", "glad",
  "perfect", "agree", "true", "correct", "right", "wow", "cool", "insightful",
  "smart", "clever", "wise", "respect", "respectfully", "well said", "spot on",
  "mast", "bindaas", "jhakaas", "zabardast", "kamal", "kamaal", "shaandaar",
  "bhai", "bhaiya", "sahi", "ekdum", "solid", "top", "fadoo", "hatke",
  "khush", "accha", "achha", "badhiya", "first class", "full too",
]);

const NEGATIVE_WORDS = new Set([
  "bad", "terrible", "awful", "worst", "hate", "hated", "stupid", "dumb",
  "idiot", "idiotic", "moron", "fool", "foolish", "wrong", "false", "fake",
  "lie", "liar", "disagree", "no", "not", "never", "fail", "failed", "failure",
  "boring", "useless", "pathetic", "disgusting", "shame", "shameful", "rubbish",
  "feku", "chamcha", "bhakt", "andhbhakt", "chamchagiri", "jumlabaaz",
  "gobar", "pappu", "buddhu", "fuddu", "bekaar", "bekar", "ghatiya",
  "bakwas", "nautanki", "drama", "attention seeker", "cringe", "embarrassing",
  "troll", "trolling", "toxic", "trash", "garbage", "nonsense",
]);

const NEGATIONS = new Set(["not", "no", "never", "don't", "dont", "doesn't", "doesnt", "isn't", "isnt", "wasn't", "wasnt", "aren't", "arent"]);

export function analyzeSentiment(text: string): SentimentResult {
  const words = text.toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/).filter(Boolean);
  let score = 0;
  let counted = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const prevWord = i > 0 ? words[i - 1]! : "";
    const negated = NEGATIONS.has(prevWord);

    if (POSITIVE_WORDS.has(word)) {
      score += negated ? -1 : 1;
      counted++;
    } else if (NEGATIVE_WORDS.has(word)) {
      score += negated ? 1 : -1;
      counted++;
    }
  }

  if (counted === 0) return { sentiment: "neutral", score: 0 };

  const normalized = Math.max(-1, Math.min(1, score / Math.max(counted, 1)));

  let sentiment: SentimentResult["sentiment"] = "neutral";
  if (normalized > 0.15) sentiment = "positive";
  else if (normalized < -0.15) sentiment = "negative";

  return { sentiment, score: Math.round(normalized * 100) / 100 };
}

export async function scrapeReplies(page: Page, postUrl: string): Promise<ScrapedReply[]> {
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge during reply scrape. Stopping.");
  }

  const replies: ScrapedReply[] = [];
  try {
    await page.waitForSelector('article [data-testid="tweetText"]', { timeout: 15_000 });
  } catch {
    return replies;
  }

  const articles = await page.$$('article').catch(() => []);
  for (let i = 1; i < articles.length; i++) {
    const article = articles[i]!;
    const text = await article.$eval('[data-testid="tweetText"]', (el) => el.textContent ?? "").catch(() => "");
    const author = await article.$eval('a[role="link"] [tabindex]', (el) => el.textContent ?? "").catch(() => "");

    if (text && text.trim()) {
      replies.push({
        text: text.trim(),
        author: String(author).trim(),
      });
    }
  }

  return replies;
}

export async function analyzePostReplies(
  db: SupabaseClient,
  page: Page,
  postUrl: string,
): Promise<SentimentSummary> {
  const replies = await scrapeReplies(page, postUrl);

  const summary: SentimentSummary = { positive: 0, negative: 0, neutral: 0, total: replies.length };

  for (const reply of replies) {
    const result = analyzeSentiment(reply.text);
    await db.insertReplySentiment({
      post_url: postUrl,
      reply_text: reply.text,
      author: reply.author,
      sentiment: result.sentiment,
      score: result.score,
    });

    if (result.sentiment === "positive") summary.positive++;
    else if (result.sentiment === "negative") summary.negative++;
    else summary.neutral++;
  }

  return summary;
}
