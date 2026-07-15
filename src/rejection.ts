import { SupabaseClient } from "./supabase";

// Analyze a draft's style characteristics from its text
export function analyzeDraftStyle(text: string): {
  is_critical: boolean;
  is_positive: boolean;
  is_sarcastic: boolean;
  is_long_form: boolean;
  word_count: number;
} {
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/);
  const wordCount = words.length;

  // Critical/cynical indicators
  const criticalWords = ["hypocrisy", "scam", "fail", "stupid", "delusional", "grift", "suicide", "bubble", "collapse", "crisis", "broken", "lie", "fake", "myth", "propaganda", "overrated", "incompetent"];
  const criticalPhrases = ["good luck", "isn't a", "is not a", "doesn't care", "doesn't work", "won't work", "never works", "adios", "rounding error"];
  const isCritical = criticalWords.some((w) => lower.includes(w)) || criticalPhrases.some((p) => lower.includes(p));

  // Positive/celebratory indicators
  const positiveWords = ["great", "amazing", "proud", "win", "success", "achievement", "milestone", "breakthrough", "historic", "incredible", "resilience", "leapfrog", "superpower", "compounding", "fastest", "first", "best", "love", "celebrate", "hype", "underrated"];
  const positivePhrases = ["went viral", "is winning", "is building", "is quietly", "is becoming", "leapfrogged", "punches above", "does it again", "is real", "is here"];
  const isPositive = positiveWords.some((w) => lower.includes(w)) || positivePhrases.some((p) => lower.includes(p));

  // Sarcastic indicators
  const sarcasticWords = ["amusing", "adorable", "cute", "bless", "cute", "sure", "right", "obviously", "clearly", "shocked", "surprised"];
  const sarcasticPhrases = ["who knew", "who would've", "shocked", "surprised", "bless their", "good for them", "well done", "great job"];
  const isSarcastic = sarcasticWords.some((w) => lower.includes(w)) || sarcasticPhrases.some((p) => lower.includes(p));

  // Long form = more than 40 words
  const isLongForm = wordCount > 40;

  return {
    is_critical: isCritical,
    is_positive: isPositive,
    is_sarcastic: isSarcastic,
    is_long_form: isLongForm,
    word_count: wordCount,
  };
}

// Build a "rejection feedback" section for the prompt
// This tells the model what styles/topics to avoid
export async function buildRejectionFeedback(db: SupabaseClient): Promise<string> {
  try {
    const [recentRejections, blockedTopics] = await Promise.all([
      db.getRecentRejections(15),
      db.getBlockedTopics(),
    ]);

    const parts: string[] = [];

    // Blocked topics
    if (blockedTopics.length > 0) {
      parts.push("BLOCKED TOPICS (do NOT generate posts about these — user rejected them multiple times):");
      for (const topic of blockedTopics.slice(0, 10)) {
        parts.push(`  - ${topic}`);
      }
      parts.push("");
    }

    // Style feedback from recent rejections
    if (recentRejections.length >= 3) {
      const criticalCount = recentRejections.filter((r) => r.is_critical).length;
      const sarcasticCount = recentRejections.filter((r) => r.is_sarcastic).length;
      const longFormCount = recentRejections.filter((r) => r.is_long_form).length;
      const positiveCount = recentRejections.filter((r) => r.is_positive).length;
      const total = recentRejections.length;

      const styleWarnings: string[] = [];
      if (criticalCount / total > 0.5) {
        styleWarnings.push(`- User rejected ${criticalCount}/${total} recent drafts that were CRITICAL/CYNICAL. Reduce critical posts. Be more positive and celebratory.`);
      }
      if (sarcasticCount / total > 0.4) {
        styleWarnings.push(`- User rejected ${sarcasticCount}/${total} recent drafts that were SARCASTIC. Reduce sarcasm. Be genuine.`);
      }
      if (longFormCount / total > 0.4) {
        styleWarnings.push(`- User rejected ${longFormCount}/${total} recent drafts that were TOO LONG. Keep posts shorter — 1-2 lines max.`);
      }
      if (positiveCount / total < 0.15) {
        styleWarnings.push(`- Only ${positiveCount}/${total} rejected drafts were positive. User seems to WANT more positive content. Default to celebration over criticism.`);
      }

      if (styleWarnings.length > 0) {
        parts.push("LEARNING FROM REJECTIONS (user rejected these styles — adjust your output):");
        parts.push(...styleWarnings);
        parts.push("");

        // Show a few rejected examples
        parts.push("RECENTLY REJECTED (do NOT repeat these styles or angles):");
        for (const r of recentRejections.slice(0, 5)) {
          parts.push(`  - "${r.draft_text.slice(0, 100)}"`);
        }
        parts.push("");
      }
    }

    return parts.length > 0 ? parts.join("\n") : "";
  } catch {
    return "";
  }
}

// Log a rejection with style analysis
export async function logRejection(
  db: SupabaseClient,
  draft: {
    id: string;
    draft_text: string;
    trend_topic: string | null;
    action_type: string | null;
  },
): Promise<{ blocked: boolean; rejection_count: number } | null> {
  try {
    const style = analyzeDraftStyle(draft.draft_text);

    await db.logRejection({
      draft_id: draft.id,
      draft_text: draft.draft_text,
      trend_topic: draft.trend_topic,
      action_type: draft.action_type,
      ...style,
    });

    // If there's a trend topic, track its rejection count
    if (draft.trend_topic) {
      const result = await db.incrementTopicRejection(draft.trend_topic);
      return { blocked: result.blocked, rejection_count: result.rejection_count };
    }

    return null;
  } catch {
    return null;
  }
}
