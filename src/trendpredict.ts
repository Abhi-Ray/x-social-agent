import type { Page } from "playwright";
import { checkForChallenge } from "./session";
import { scrapeTrending } from "./scraper";
import type { SupabaseClient } from "./supabase";
import type { EmergingTopic, TrendPrediction } from "./types";

interface TopicEngagement {
  topic: string;
  engagement: number;
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

export async function scrapeEmergingTopics(page: Page, db: SupabaseClient): Promise<EmergingTopic[]> {
  const trends = await scrapeTrending(page);
  if (!trends.length) return [];

  const searchUrl = `https://x.com/search?q=${encodeURIComponent(trends.slice(0, 10).map((t) => t.topic_text).join(" OR "))}&src=trend_click&f=top`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  if (await checkForChallenge(page)) {
    throw new Error("CHALLENGE: X is showing a challenge during emerging topics scrape. Stopping.");
  }

  const currentEngagement = new Map<string, number>();
  try {
    await page.waitForSelector('article [data-testid="tweetText"]', { timeout: 15_000 });
  } catch {
    return [];
  }

  const articles = await page.$$('article').catch(() => []);
  for (const article of articles) {
    const text = await article.$eval('[data-testid="tweetText"]', (el) => el.textContent ?? "").catch(() => "");
    if (!text) continue;
    const likeLabel = await article.$eval('[data-testid="like"]', (el) => el.getAttribute("aria-label") ?? "").catch(() => "");
    const retweetLabel = await article.$eval('[data-testid="retweet"]', (el) => el.getAttribute("aria-label") ?? "").catch(() => "");
    const replyLabel = await article.$eval('[data-testid="reply"]', (el) => el.getAttribute("aria-label") ?? "").catch(() => "");
    const engagement = parseEngagementCount(likeLabel) + parseEngagementCount(retweetLabel) + parseEngagementCount(replyLabel);

    const lowerText = text.toLowerCase();
    for (const trend of trends) {
      if (lowerText.includes(trend.topic_text.toLowerCase())) {
        currentEngagement.set(trend.topic_text, (currentEngagement.get(trend.topic_text) ?? 0) + engagement);
      }
    }
  }

  const previousTrends = await db.getRecentTrends(3);
  const previousEngagement = new Map<string, number>();
  for (const trend of previousTrends) {
    previousEngagement.set(trend.topic_text, (previousEngagement.get(trend.topic_text) ?? 0) + 1);
  }

  const emerging: EmergingTopic[] = [];
  for (const trend of trends) {
    const topic = trend.topic_text;
    const current = currentEngagement.get(topic) ?? 0;
    const previous = previousEngagement.get(topic) ?? 0;

    if (current < 50) continue;

    const growthRate = previous > 0 ? (current - previous) / previous : current > 0 ? 1 : 0;
    if (growthRate <= 0) continue;

    const predictionScore = computePredictionScore(current, growthRate, previous);
    if (predictionScore < 0.3) continue;

    emerging.push({
      topic,
      predictionScore,
      currentEngagement: current,
      growthRate,
    });
  }

  return emerging.sort((a, b) => b.predictionScore - a.predictionScore).slice(0, 10);
}

function computePredictionScore(currentEngagement: number, growthRate: number, previousEngagement: number): number {
  const engagementScore = Math.min(currentEngagement / 1000, 1);
  const growthScore = Math.min(growthRate / 2, 1);
  const noveltyScore = previousEngagement === 0 ? 0.5 : Math.max(0, 1 - previousEngagement / 20);
  const score = 0.4 * engagementScore + 0.4 * growthScore + 0.2 * noveltyScore;
  return Math.max(0, Math.min(1, score));
}

export async function predictAndStore(db: SupabaseClient, topics: EmergingTopic[]): Promise<void> {
  if (!topics.length) return;
  await db.insertTrendPredictions(
    topics.map((t) => ({
      topic: t.topic,
      prediction_score: t.predictionScore,
      current_engagement: t.currentEngagement,
      growth_rate: t.growthRate,
    })),
  );
}

export async function checkPredictionsTrended(page: Page, db: SupabaseClient): Promise<number> {
  const predictions = await db.getRecentTrendPredictions(7);
  const unverified = predictions.filter((p) => p.trended_at === null);
  if (!unverified.length) return 0;

  const currentTrends = await scrapeTrending(page);
  const trendingSet = new Set(currentTrends.map((t) => t.topic_text.toLowerCase()));

  let count = 0;
  for (const prediction of unverified) {
    if (trendingSet.has(prediction.topic.toLowerCase())) {
      await db.markTrendPredictionTrended(prediction.id);
      count++;
    }
  }
  return count;
}

export async function getPredictedTopicsToPost(db: SupabaseClient): Promise<TrendPrediction[]> {
  return db.getUnpostedTrendPredictions(10);
}
