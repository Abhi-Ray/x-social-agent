import type { SupabaseClient } from "./supabase";
import { getISTHour } from "./config";

export interface HourlyEngagement {
  hour_ist: number;
  total_engagement: number;
  post_count: number;
}

export interface BestPostingHour {
  hour: number;
  avgEngagement: number;
  postCount: number;
}

export interface PostSchedule {
  recommendedHours: number[];
  expectedEngagement: Record<number, number>;
  currentHour: number;
  isGoodTime: boolean;
}

export async function updateEngagementByHour(
  db: SupabaseClient,
  postHour: number,
  engagement: number,
): Promise<void> {
  await db.updateHourlyEngagement(postHour, engagement);
}

export async function getBestPostingHours(db: SupabaseClient, topN = 5): Promise<BestPostingHour[]> {
  const rows = await db.getEngagementByHour();
  const byHour = new Map<number, { total: number; count: number }>();

  for (const row of rows) {
    const existing = byHour.get(row.hour_ist) ?? { total: 0, count: 0 };
    existing.total += row.total_engagement;
    existing.count += row.post_count;
    byHour.set(row.hour_ist, existing);
  }

  const result: BestPostingHour[] = [];
  for (const [hour, data] of byHour) {
    result.push({
      hour,
      avgEngagement: data.count > 0 ? data.total / data.count : 0,
      postCount: data.count,
    });
  }

  result.sort((a, b) => b.avgEngagement - a.avgEngagement);
  return result.slice(0, topN);
}

export async function isGoodTimeToPost(db: SupabaseClient): Promise<boolean> {
  const currentHour = getISTHour();
  const bestHours = await getBestPostingHours(db, 5);
  if (!bestHours.length) return true;
  return bestHours.some((h) => h.hour === currentHour);
}

export async function getOptimalPostSchedule(db: SupabaseClient): Promise<PostSchedule> {
  const bestHours = await getBestPostingHours(db, 5);
  const currentHour = getISTHour();
  const recommendedHours = bestHours.map((h) => h.hour);
  const expectedEngagement: Record<number, number> = {};
  for (const h of bestHours) {
    expectedEngagement[h.hour] = Math.round(h.avgEngagement * 100) / 100;
  }

  return {
    recommendedHours,
    expectedEngagement,
    currentHour,
    isGoodTime: recommendedHours.includes(currentHour),
  };
}
