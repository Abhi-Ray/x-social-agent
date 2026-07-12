import type { SupabaseClient } from "./supabase";
import type { ContentPillarLog, PillarPerformance } from "./types";

export const CONTENT_PILLARS = [
  "finance",
  "tech",
  "philosophy",
  "politics",
  "culture",
  "india_specific",
  "sports",
  "hot_take",
] as const;

export type ContentPillar = (typeof CONTENT_PILLARS)[number];

const PILLAR_INSTRUCTIONS: Record<ContentPillar, string> = {
  finance: "Focus on Indian markets, SIPs, mutual funds, crypto regulations. Talk about money like you have it.",
  tech: "Focus on AI, startups, technology, the internet. Be opinionated about where things are going. Roast bad tech takes.",
  philosophy: "Focus on stoicism, life, mindset, wisdom. Channel Marcus Aurelius, Seneca, Epictetus. Practical, not preachy.",
  politics: "Focus on Indian politics, governance, policy. Roast all sides equally. No team, just analysis.",
  culture: "Focus on movies, cricket, entertainment, society. Witty takes on what everyone is watching.",
  india_specific: "Focus on Indian companies, Indian startups, Indian problems. Relatable to 1.4 billion people.",
  sports: "Focus on cricket, football, IPL, Olympics. Hot takes on games, players, and controversies.",
  hot_take: "Contrarian opinions on trending topics. Split the room 50/50. Be the take people argue about.",
};

export async function getLastUsedPillars(db: SupabaseClient, count = 5): Promise<string[]> {
  const logs = await db.getRecentPillarLogs(count);
  return logs.map((log) => log.pillar);
}

export async function pickNextPillar(db: SupabaseClient): Promise<string> {
  const recent = await getLastUsedPillars(db, 5);
  const lastPillar = recent[0] ?? null;

  let performance: PillarPerformance[] = [];
  try {
    performance = await db.getPillarPerformance();
  } catch {
    performance = [];
  }

  const perfMap = new Map<string, number>();
  for (const perf of performance) {
    perfMap.set(perf.pillar, perf.avg_engagement);
  }
  const maxEngagement = Math.max(...performance.map((p) => p.avg_engagement), 1);

  const weights: Array<{ pillar: ContentPillar; weight: number }> = CONTENT_PILLARS.map((pillar) => {
    if (pillar === lastPillar) return { pillar, weight: 0 };
    const recentIndex = recent.indexOf(pillar);
    const recencyPenalty = recentIndex >= 0 ? (recent.length - recentIndex) * 0.5 : 0;
    const engBoost = (perfMap.get(pillar) ?? 0) / maxEngagement;
    return { pillar, weight: Math.max(0.1, 1 + engBoost - recencyPenalty) };
  });

  const eligible = weights.filter((w) => w.weight > 0);
  if (!eligible.length) {
    const fallback = CONTENT_PILLARS.find((p) => p !== lastPillar) ?? CONTENT_PILLARS[0];
    return fallback;
  }

  const totalWeight = eligible.reduce((sum, w) => sum + w.weight, 0);
  let random = Math.random() * totalWeight;
  for (const entry of eligible) {
    random -= entry.weight;
    if (random <= 0) return entry.pillar;
  }
  return eligible[eligible.length - 1]?.pillar ?? CONTENT_PILLARS[0];
}

export function getPillarInstructions(pillar: string): string {
  return PILLAR_INSTRUCTIONS[pillar as ContentPillar] ?? "";
}

export async function logPillarUse(
  db: SupabaseClient,
  pillar: string,
  postUrl?: string,
  engagementScore?: number,
): Promise<void> {
  await db.insertPillarLog({
    pillar,
    post_url: postUrl ?? null,
    engagement_score: engagementScore ?? null,
  });
}

export async function getPillarPerformance(db: SupabaseClient): Promise<PillarPerformance[]> {
  return db.getPillarPerformance();
}
