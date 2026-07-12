import type {
  AccountHealthLog, DailyCounter, Draft, DraftStatus, PendingAction,
  PostedContent, TrendingTopic, VerifiedQuote, ActionType,
} from "./types";
import { localDate } from "./config";

export class SupabaseClient {
  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text || !text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Supabase returned invalid JSON for ${path}: ${text.slice(0, 200)}`);
    }
  }

  // ─── Trending topics ───
  async insertTrends(topics: Array<{ topic_text: string; category: string | null }>): Promise<void> {
    if (!topics.length) return;
    await this.request("trending_topics", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(topics),
    });
  }

  async getRecentTrends(days = 3): Promise<TrendingTopic[]> {
    const since = localDate(-(days - 1));
    return this.request<TrendingTopic[]>(`trending_topics?scraped_at=gte.${since}T00:00:00&select=*&order=scraped_at.desc&limit=50`);
  }

  async getUnusedTrends(limit = 10): Promise<TrendingTopic[]> {
    return this.request<TrendingTopic[]>(`trending_topics?used_count=eq.0&select=*&order=scraped_at.desc&limit=${limit}`);
  }

  async incrementTrendUsage(id: string): Promise<void> {
    await this.request(`trending_topics?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ used_count: 1 }), // Supabase doesn't support atomic increment via REST; fetch+update is fine for low volume
    });
  }

  // ─── Drafts ───
  async insertDraft(draft: {
    action_type: ActionType;
    source_tweet_url: string | null;
    source_tweet_text: string | null;
    source_tweet_author: string | null;
    draft_text: string;
    quote_text: string | null;
    quote_attributed_to: string | null;
    quote_source: string | null;
    trend_topic: string | null;
    telegram_message_id: number | null;
  }): Promise<Draft> {
    const rows = await this.request<Draft[]>("drafts", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ ...draft, status: "pending_approval" as DraftStatus }),
    });
    if (!rows[0]) throw new Error("Draft insert returned no row");
    return rows[0];
  }

  async getDraftById(id: string): Promise<Draft | null> {
    const rows = await this.request<Draft[]>(`drafts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  async getDraftByTelegramMessageId(messageId: number): Promise<Draft | null> {
    const rows = await this.request<Draft[]>(`drafts?telegram_message_id=eq.${messageId}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  async updateDraftStatus(id: string, status: DraftStatus, extra: Record<string, unknown> = {}): Promise<void> {
    await this.request(`drafts?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status, ...extra }),
    });
  }

  async updateDraftText(id: string, text: string): Promise<void> {
    await this.request(`drafts?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ draft_text: text, status: "pending_approval" }),
    });
  }

  async getRecentDrafts(limit = 20): Promise<Draft[]> {
    return this.request<Draft[]>(`drafts?select=*&order=created_at.desc&limit=${limit}`);
  }

  async getApprovedDrafts(): Promise<Draft[]> {
    return this.request<Draft[]>(`drafts?status=eq.approved&select=*&order=approved_at.asc`);
  }

  // ─── Pending actions ───
  async createPendingAction(draftId: string): Promise<PendingAction> {
    const rows = await this.request<PendingAction[]>("pending_actions", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ draft_id: draftId, result: "pending" }),
    });
    if (!rows[0]) throw new Error("Pending action insert returned no row");
    return rows[0];
  }

  async getPendingActions(): Promise<PendingAction[]> {
    return this.request<PendingAction[]>(`pending_actions?result=eq.pending&select=*&order=approved_at.asc`);
  }

  async updatePendingAction(id: string, values: Partial<PendingAction>): Promise<void> {
    await this.request(`pending_actions?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(values),
    });
  }

  // ─── Posted content (dedup + context awareness) ───
  async insertPostedContent(values: {
    text_hash: string;
    action_type: ActionType;
    posted_text: string;
    x_post_url: string | null;
  }): Promise<void> {
    await this.request("posted_content", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(values),
    });
  }

  async getRecentPosts(limit = 20): Promise<PostedContent[]> {
    return this.request<PostedContent[]>(`posted_content?select=*&order=posted_at.desc&limit=${limit}`);
  }

  async getPostByHash(hash: string): Promise<PostedContent | null> {
    const rows = await this.request<PostedContent[]>(`posted_content?text_hash=eq.${encodeURIComponent(hash)}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  async findSimilarPosts(text: string, threshold = 0.6): Promise<PostedContent[]> {
    const recent = await this.getRecentPosts(30);
    return recent.filter((post) => {
      const sim = this.wordSimilarity(text, post.posted_text);
      return sim >= threshold;
    });
  }

  private wordSimilarity(a: string, b: string): number {
    const na = new Set(a.trim().toLowerCase().split(/\s+/));
    const nb = new Set(b.trim().toLowerCase().split(/\s+/));
    const intersection = [...na].filter((w) => nb.has(w)).length;
    const union = new Set([...na, ...nb]).size;
    return union === 0 ? 0 : intersection / union;
  }

  // ─── Daily counters ───
  async getDailyCounter(date: string): Promise<DailyCounter | null> {
    const rows = await this.request<DailyCounter[]>(`daily_counters?date=eq.${date}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  async upsertDailyCounter(date: string, values: Partial<DailyCounter>): Promise<void> {
    await this.request(`daily_counters?on_conflict=date`, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ date, ...values }),
    });
  }

  async incrementDailyCounter(date: string, actionType: ActionType): Promise<void> {
    const existing = await this.getDailyCounter(date);
    const field = actionType;
    const current = existing ? (existing[field] ?? 0) : 0;
    await this.upsertDailyCounter(date, { [field]: current + 1 } as Partial<DailyCounter>);
  }

  async canPerformAction(date: string, actionType: ActionType, caps: Record<ActionType, number>): Promise<boolean> {
    const counter = await this.getDailyCounter(date);
    if (!counter) return true;
    return (counter[actionType] ?? 0) < caps[actionType];
  }

  // ─── Account health ───
  async logHealthEvent(date: string, type: "challenge" | "failure", notes?: string): Promise<void> {
    const existing = await this.request<AccountHealthLog[]>(`account_health_log?date=eq.${date}&select=*&limit=1`);
    if (existing[0]) {
      const updates: Record<string, unknown> = {};
      if (type === "challenge") updates.challenges_hit = existing[0].challenges_hit + 1;
      if (type === "failure") updates.failures = existing[0].failures + 1;
      if (notes) updates.notes = [existing[0].notes, notes].filter(Boolean).join("; ");
      await this.request(`account_health_log?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify(updates),
      });
    } else {
      await this.request("account_health_log", {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          date,
          challenges_hit: type === "challenge" ? 1 : 0,
          failures: type === "failure" ? 1 : 0,
          notes: notes ?? null,
        }),
      });
    }
  }

  // ─── Verified quotes ───
  async getVerifiedQuotes(limit = 50): Promise<VerifiedQuote[]> {
    return this.request<VerifiedQuote[]>(`verified_quotes?select=*&order=last_used_at.asc&limit=${limit}`);
  }

  async getRandomQuotes(sampleSize = 15): Promise<VerifiedQuote[]> {
    const all = await this.getVerifiedQuotes(100);
    // Shuffle and take sample — prefer least-recently-used
    const sorted = [...all].sort((a, b) => {
      const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      return aTime - bTime;
    });
    return sorted.slice(0, sampleSize);
  }

  async markQuoteUsed(id: string): Promise<void> {
    const rows = await this.request<VerifiedQuote[]>(`verified_quotes?id=eq.${encodeURIComponent(id)}&select=times_used&limit=1`);
    const current = rows[0]?.times_used ?? 0;
    await this.request(`verified_quotes?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ times_used: current + 1, last_used_at: new Date().toISOString() }),
    });
  }

  async insertVerifiedQuote(quote: {
    text: string;
    attributed_to: string;
    source_work: string;
    verified_by: string;
    notes?: string | null;
  }): Promise<void> {
    await this.request("verified_quotes", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(quote),
    });
  }
}
