import type {
  AccountHealthLog, DailyCounter, Draft, DraftStatus, PendingAction,
  PostedContent, TrendingTopic, VerifiedQuote, ActionType, ABTestVariant,
  TrendPrediction, NewFollower, HashtagPerformance, HashtagStat, MentionQueueEntry,
  CrossPostLog, ContentPillarLog, PillarPerformance, ViralTemplate,
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

  async getPostsForEngagementCheck(limit = 20): Promise<PostedContent[]> {
    // Get posts that have a URL and are older than 1 hour (give time for engagement to accumulate)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    return this.request<PostedContent[]>(
      `posted_content?x_post_url=not.is.null&posted_at=lt.${oneHourAgo}&select=*&order=posted_at.desc&limit=${limit}`,
    );
  }

  async updateEngagement(id: string, metrics: { engagement_likes: number; engagement_retweets: number; engagement_replies: number }): Promise<void> {
    await this.request(`posted_content?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(metrics),
    });
  }

  async getTopPerformingPosts(limit = 10): Promise<PostedContent[]> {
    // Get posts with highest engagement (likes + retweets + replies)
    return this.request<PostedContent[]>(
      `posted_content?engagement_likes=not.is.null&select=*&order=engagement_likes.desc&limit=${limit}`,
    );
  }

  async getLowPerformingPosts(limit = 10): Promise<PostedContent[]> {
    return this.request<PostedContent[]>(
      `posted_content?engagement_likes=not.is.null&select=*&order=engagement_likes.asc&limit=${limit}`,
    );
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

  // ─── Followed accounts (auto-follow) ───
  async insertFollowedAccount(account: {
    handle: string;
    name: string;
    category: string;
    followers_count: number;
  }): Promise<void> {
    await this.request("followed_accounts", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        ...account,
        follows_back: false,
        followed_at: new Date().toISOString(),
      }),
    });
  }

  async getFollowedAccount(handle: string): Promise<{ id: string; handle: string; follows_back: boolean } | null> {
    const rows = await this.request<Array<{ id: string; handle: string; follows_back: boolean }>>(
      `followed_accounts?handle=eq.${encodeURIComponent(handle)}&select=*&limit=1`,
    );
    return rows[0] ?? null;
  }

  async markFollowBack(handle: string, followsBack: boolean): Promise<void> {
    await this.request(`followed_accounts?handle=eq.${encodeURIComponent(handle)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ follows_back: followsBack, checked_at: new Date().toISOString() }),
    });
  }

  async getNonFollowBackAccounts(threshold: string): Promise<Array<{ id: string; handle: string }>> {
    return this.request<Array<{ id: string; handle: string }>>(
      `followed_accounts?follows_back=eq.false&followed_at=lt.${threshold}&select=id,handle`,
    );
  }

  async markAccountUnfollowed(id: string): Promise<void> {
    await this.request(`followed_accounts?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ unfollowed_at: new Date().toISOString() }),
    });
  }

  // ─── Engagement by hour (best time to post) ───
  async updateHourlyEngagement(hourIst: number, engagement: number): Promise<void> {
    const existing = await this.request<Array<{ id: string; hour_ist: number; total_engagement: number; post_count: number }>>(
      `engagement_by_hour?hour_ist=eq.${hourIst}&select=*&limit=1`,
    );
    if (existing[0]) {
      await this.request(`engagement_by_hour?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          total_engagement: existing[0].total_engagement + engagement,
          post_count: existing[0].post_count + 1,
          updated_at: new Date().toISOString(),
        }),
      });
    } else {
      await this.request("engagement_by_hour", {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          hour_ist: hourIst,
          total_engagement: engagement,
          post_count: 1,
        }),
      });
    }
  }

  async getEngagementByHour(): Promise<Array<{ hour_ist: number; total_engagement: number; post_count: number }>> {
    return this.request<Array<{ hour_ist: number; total_engagement: number; post_count: number }>>(
      `engagement_by_hour?select=hour_ist,total_engagement,post_count&order=hour_ist.asc`,
    );
  }

  // ─── Reply sentiment ───
  async insertReplySentiment(reply: {
    post_url: string;
    reply_text: string;
    author: string;
    sentiment: "positive" | "negative" | "neutral";
    score: number;
  }): Promise<void> {
    await this.request("reply_sentiment", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ ...reply, created_at: new Date().toISOString() }),
    });
  }

  async getReplySentimentByPost(postUrl: string): Promise<Array<{
    id: string;
    reply_text: string;
    author: string;
    sentiment: "positive" | "negative" | "neutral";
    score: number;
  }>> {
    return this.request(
      `reply_sentiment?post_url=eq.${encodeURIComponent(postUrl)}&select=*&order=created_at.desc`,
    );
  }

  async getSentimentSummary(): Promise<Array<{ sentiment: string; count: string }>> {
    return this.request(
      `reply_sentiment?select=sentiment&order=sentiment.asc`,
    );
  }

  // ─── A/B test variants ───
  async insertABVariant(variant: {
    test_group: string;
    variant: "A" | "B";
    topic: string;
    text: string;
  }): Promise<ABTestVariant> {
    const rows = await this.request<ABTestVariant[]>("ab_test_variants", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(variant),
    });
    if (!rows[0]) throw new Error("AB test variant insert returned no row");
    return rows[0];
  }

  async updateABVariantEngagement(
    id: string,
    engagement: { engagement_likes: number; engagement_retweets: number; engagement_replies: number },
  ): Promise<void> {
    await this.request(`ab_test_variants?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(engagement),
    });
  }

  async getABTestGroup(testGroup: string): Promise<ABTestVariant[]> {
    return this.request<ABTestVariant[]>(
      `ab_test_variants?test_group=eq.${encodeURIComponent(testGroup)}&select=*&order=created_at.asc`,
    );
  }

  async markABVariantWinner(id: string): Promise<void> {
    await this.request(`ab_test_variants?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ is_winner: true }),
    });
  }

  // ─── Trend predictions ───
  async insertTrendPredictions(predictions: Array<{
    topic: string;
    prediction_score: number;
    current_engagement: number;
    growth_rate: number;
  }>): Promise<void> {
    if (!predictions.length) return;
    await this.request("trend_predictions", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(predictions),
    });
  }

  async getRecentTrendPredictions(days = 7): Promise<TrendPrediction[]> {
    const since = localDate(-(days - 1));
    return this.request<TrendPrediction[]>(
      `trend_predictions?predicted_at=gte.${since}T00:00:00&select=*&order=predicted_at.desc&limit=100`,
    );
  }

  async getUnpostedTrendPredictions(limit = 10): Promise<TrendPrediction[]> {
    return this.request<TrendPrediction[]>(
      `trend_predictions?posted_at=is.null&select=*&order=prediction_score.desc&limit=${limit}`,
    );
  }

  async markTrendPredictionTrended(id: string): Promise<void> {
    await this.request(`trend_predictions?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ trended_at: new Date().toISOString() }),
    });
  }

  async markTrendPredictionPosted(id: string): Promise<void> {
    await this.request(`trend_predictions?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ posted_at: new Date().toISOString() }),
    });
  }

  // ─── New followers ───
  async insertNewFollowers(followers: Array<{ handle: string; name: string }>): Promise<void> {
    if (!followers.length) return;
    await this.request("new_followers", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(followers.map((f) => ({ handle: f.handle, name: f.name, dm_sent: false }))),
    });
  }

  async getNewFollowersWithoutDM(limit = 50): Promise<NewFollower[]> {
    return this.request<NewFollower[]>(
      `new_followers?dm_sent=eq.false&select=*&order=followed_us_at.asc&limit=${limit}`,
    );
  }

  async getKnownFollowerHandles(limit = 500): Promise<Set<string>> {
    const rows = await this.request<NewFollower[]>(`new_followers?select=handle&limit=${limit}`);
    return new Set(rows.map((r) => r.handle));
  }

  async markFollowerDMSent(id: string): Promise<void> {
    await this.request(`new_followers?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ dm_sent: true, dm_sent_at: new Date().toISOString() }),
    });
  }

  // ─── Hashtag performance ───
  async insertHashtagPerformance(entry: {
    hashtag: string;
    post_url: string | null;
    engagement: number;
  }): Promise<void> {
    await this.request("hashtag_performance", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(entry),
    });
  }

  async getTopHashtags(limit = 10): Promise<HashtagStat[]> {
    const rows = await this.request<Array<{ hashtag: string; likes: number; retweets: number; replies: number }>>(
      `hashtag_performance?select=hashtag,likes,retweets,replies&limit=500`,
    );
    const grouped = new Map<string, { total: number; count: number }>();
    for (const row of rows) {
      const stat = grouped.get(row.hashtag) ?? { total: 0, count: 0 };
      stat.total += (row.likes ?? 0) + (row.retweets ?? 0) + (row.replies ?? 0);
      stat.count += 1;
      grouped.set(row.hashtag, stat);
    }
    const stats: HashtagStat[] = [];
    for (const [hashtag, { total, count }] of grouped) {
      stats.push({ hashtag, avg_engagement: count > 0 ? total / count : 0, total_posts: count });
    }
    return stats.sort((a, b) => b.avg_engagement - a.avg_engagement).slice(0, limit);
  }

  async getHashtagStats(hashtag: string): Promise<HashtagStat | null> {
    const rows = await this.request<Array<{ engagement: number }>>(
      `hashtag_performance?hashtag=eq.${encodeURIComponent(hashtag)}&select=engagement`,
    );
    if (!rows.length) return null;
    const total = rows.reduce((sum, r) => sum + (r.engagement ?? 0), 0);
    return { hashtag, avg_engagement: total / rows.length, total_posts: rows.length };
  }

  // ─── Mention queue ───
  async insertMentionQueueEntry(entry: {
    tweet_url: string;
    author_handle: string;
    author_name: string;
    tweet_text: string;
  }): Promise<void> {
    await this.request("mention_queue", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ ...entry, replied: false }),
    });
  }

  async getRepliedMentionUrls(limit = 200): Promise<Set<string>> {
    const rows = await this.request<MentionQueueEntry[]>(
      `mention_queue?replied=eq.true&select=tweet_url&limit=${limit}`,
    );
    return new Set(rows.map((r) => r.tweet_url));
  }

  async getKnownMentionUrls(limit = 500): Promise<Set<string>> {
    const rows = await this.request<MentionQueueEntry[]>(
      `mention_queue?select=tweet_url&limit=${limit}`,
    );
    return new Set(rows.map((r) => r.tweet_url));
  }

  async markMentionReplied(tweetUrl: string): Promise<void> {
    await this.request(`mention_queue?tweet_url=eq.${encodeURIComponent(tweetUrl)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ replied: true, replied_at: new Date().toISOString() }),
    });
  }

  // ─── Competitor posts ───
  async insertCompetitorPost(post: {
    handle: string;
    post_text: string;
    post_url: string;
    likes: number;
    retweets: number;
    replies: number;
  }): Promise<void> {
    await this.request("competitor_posts", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(post),
    });
  }

  async getCompetitorPosts(handle: string, limit = 20): Promise<Array<{
    id: string;
    handle: string;
    post_text: string;
    post_url: string;
    likes: number;
    retweets: number;
    replies: number;
    scraped_at: string;
  }>> {
    return this.request(`competitor_posts?handle=eq.${encodeURIComponent(handle)}&select=*&order=scraped_at.desc&limit=${limit}`);
  }

  async getTopCompetitorPosts(limit = 20): Promise<Array<{
    id: string;
    handle: string;
    post_text: string;
    post_url: string;
    likes: number;
    retweets: number;
    replies: number;
    scraped_at: string;
  }>> {
    return this.request(`competitor_posts?select=*&order=likes.desc&limit=${limit}`);
  }

  // ─── Hindi post tracking ───
  async getRecentHindiPostCount(limit = 10): Promise<number> {
    const recent = await this.getRecentPosts(limit);
    return recent.filter((p) => {
      const text = p.posted_text;
      const hasDevanagari = /[\u0900-\u097F]/.test(text);
      const hinglishKeywords = /\b(hai|nahi|nahin|kya|kyu|kyun|bhai|yaar|sab|mera|tera|aaj|kal|phir|jab|tab|lekin|par|aur|ek|do|teen|chaar|paanch|matlab|bas|bilkul|sahi|galat|acha|accha|theek|thik|kuch|bahut|zyada|kam|jyada|pata|samajh|soch|dekh|sun|bol|likh|padh|khao|piyo|ja|aa|raha|rahi|gaya|gaye|kiya|kiye|hua|hue|wala|wali|ka|ki|ke|ne|ko|se|me|mein|par|ya|toh|hi|bhi|to|na|jo|vo|wo|yeh|woh|koi|sab|apna|apni|khud|dost|duniya|zindagi|paisa|kaam|waqt|din|raat|insaan|log|baat|baatein|khel|jeet|haar|pyar|mohabbat|dil|dimag|jigar)\b/i.test(text);
      return hasDevanagari || hinglishKeywords;
    }).length;
  }

  // ─── Cross-post log ───
  async insertCrossPostLog(values: {
    platform: "threads" | "linkedin";
    post_text: string;
    external_url: string | null;
    success: boolean;
    error: string | null;
    source_action_type: ActionType | null;
    source_post_url: string | null;
  }): Promise<void> {
    await this.request("cross_post_log", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(values),
    });
  }

  async getRecentCrossPosts(limit = 20): Promise<CrossPostLog[]> {
    return this.request<CrossPostLog[]>(`cross_post_log?select=*&order=posted_at.desc&limit=${limit}`);
  }

  async getCrossPostsByPlatform(platform: "threads" | "linkedin", limit = 20): Promise<CrossPostLog[]> {
    return this.request<CrossPostLog[]>(`cross_post_log?platform=eq.${platform}&select=*&order=posted_at.desc&limit=${limit}`);
  }

  async getCrossPostById(id: string): Promise<CrossPostLog | null> {
    const rows = await this.request<CrossPostLog[]>(`cross_post_log?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  // ─── Content pillar log ───
  async insertPillarLog(values: {
    pillar: string;
    post_url: string | null;
    engagement_score: number | null;
  }): Promise<void> {
    await this.request("content_pillar_log", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(values),
    });
  }

  async getRecentPillarLogs(limit = 10): Promise<ContentPillarLog[]> {
    return this.request<ContentPillarLog[]>(`content_pillar_log?select=*&order=used_at.desc&limit=${limit}`);
  }

  async getPillarLogsByPillar(pillar: string, limit = 20): Promise<ContentPillarLog[]> {
    return this.request<ContentPillarLog[]>(`content_pillar_log?pillar=eq.${encodeURIComponent(pillar)}&select=*&order=used_at.desc&limit=${limit}`);
  }

  async updatePillarLogEngagement(id: string, engagementScore: number): Promise<void> {
    await this.request(`content_pillar_log?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ engagement_score: engagementScore }),
    });
  }

  async getPillarPerformance(): Promise<PillarPerformance[]> {
    const logs = await this.request<ContentPillarLog[]>(`content_pillar_log?select=*&order=used_at.desc&limit=500`);
    const grouped = new Map<string, { scores: number[]; lastUsed: string | null; count: number }>();
    for (const log of logs) {
      const entry = grouped.get(log.pillar) ?? { scores: [], lastUsed: null, count: 0 };
      entry.count++;
      if (log.engagement_score !== null) entry.scores.push(log.engagement_score);
      if (!entry.lastUsed || (log.used_at && log.used_at > entry.lastUsed)) {
        entry.lastUsed = log.used_at;
      }
      grouped.set(log.pillar, entry);
    }
    const result: PillarPerformance[] = [];
    for (const [pillar, entry] of grouped) {
      const avg = entry.scores.length > 0 ? entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length : 0;
      result.push({ pillar, total_posts: entry.count, avg_engagement: avg, last_used_at: entry.lastUsed });
    }
    return result.sort((a, b) => b.avg_engagement - a.avg_engagement);
  }

  // ─── Viral templates ───
  async insertViralTemplate(values: {
    template: string;
    source: string;
    avg_engagement: number;
    times_used?: number;
  }): Promise<void> {
    await this.request("viral_templates", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ template_text: values.template, source: values.source, avg_engagement: values.avg_engagement, times_used: values.times_used ?? 0 }),
    });
  }

  async getTopViralTemplates(limit = 10): Promise<ViralTemplate[]> {
    return this.request<ViralTemplate[]>(`viral_templates?select=*&order=avg_engagement.desc,times_used.desc&limit=${limit}`);
  }

  async getViralTemplateById(id: string): Promise<ViralTemplate | null> {
    const rows = await this.request<ViralTemplate[]>(`viral_templates?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  async incrementTemplateUsage(id: string): Promise<void> {
    const rows = await this.request<ViralTemplate[]>(`viral_templates?id=eq.${encodeURIComponent(id)}&select=times_used&limit=1`);
    const current = rows[0]?.times_used ?? 0;
    await this.request(`viral_templates?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ times_used: current + 1, last_used_at: new Date().toISOString() }),
    });
  }

  async getUnusedViralTemplate(): Promise<ViralTemplate | null> {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const rows = await this.request<ViralTemplate[]>(
      `viral_templates?or=(last_used_at.is.null,last_used_at.lt.${today}T00:00:00)&select=*&order=avg_engagement.desc,times_used.asc&limit=1`,
    );
    return rows[0] ?? null;
  }

  async getTemplatesUsedToday(today: string): Promise<number> {
    const rows = await this.request<ViralTemplate[]>(
      `viral_templates?last_used_at=gte.${today}T00:00:00&select=id&limit=100`,
    );
    return rows.length;
  }

  async deleteViralTemplate(id: string): Promise<void> {
    await this.request(`viral_templates?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
  }

  // ─── Rejection learning ───

  async logRejection(entry: {
    draft_id: string | null;
    draft_text: string;
    trend_topic: string | null;
    action_type: string | null;
    is_critical: boolean;
    is_positive: boolean;
    is_sarcastic: boolean;
    is_long_form: boolean;
    word_count: number;
  }): Promise<void> {
    try {
      await this.request("rejection_log", {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify(entry),
      });
    } catch {
      // Table might not exist yet — non-fatal
    }
  }

  async getRecentRejections(limit = 20): Promise<Array<{
    draft_text: string;
    trend_topic: string | null;
    is_critical: boolean;
    is_positive: boolean;
    is_sarcastic: boolean;
    is_long_form: boolean;
    word_count: number;
    rejected_at: string;
  }>> {
    try {
      return await this.request(
        `rejection_log?order=rejected_at.desc&limit=${limit}&select=draft_text,trend_topic,is_critical,is_positive,is_sarcastic,is_long_form,word_count,rejected_at`,
      );
    } catch {
      return [];
    }
  }

  // ─── Blocked topics ───

  async incrementTopicRejection(topic: string): Promise<{ rejection_count: number; blocked: boolean }> {
    const normalized = topic.trim().toLowerCase();
    try {
      // Try to update existing
      const existing = await this.request<Array<{ id: string; rejection_count: number; blocked_at: string | null }>>(
        `blocked_topics?topic=eq.${encodeURIComponent(normalized)}&select=id,rejection_count,blocked_at`,
      );

      if (existing.length > 0) {
        const row = existing[0]!;
        const newCount = row.rejection_count + 1;
        const shouldBlock = newCount >= 2 && !row.blocked_at;
        await this.request(`blocked_topics?id=eq.${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify({
            rejection_count: newCount,
            last_rejected_at: new Date().toISOString(),
            ...(shouldBlock ? { blocked_at: new Date().toISOString() } : {}),
          }),
        });
        return { rejection_count: newCount, blocked: shouldBlock || !!row.blocked_at };
      } else {
        // Insert new
        await this.request("blocked_topics", {
          method: "POST",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify({
            topic: normalized,
            rejection_count: 1,
            first_rejected_at: new Date().toISOString(),
            last_rejected_at: new Date().toISOString(),
          }),
        });
        return { rejection_count: 1, blocked: false };
      }
    } catch {
      return { rejection_count: 0, blocked: false };
    }
  }

  async getBlockedTopics(): Promise<string[]> {
    try {
      const rows = await this.request<Array<{ topic: string }>>(
        `blocked_topics?blocked_at=not.is.null&select=topic`,
      );
      return rows.map((r) => r.topic);
    } catch {
      return [];
    }
  }

  async isTopicBlocked(topic: string): Promise<boolean> {
    const normalized = topic.trim().toLowerCase();
    try {
      const rows = await this.request<Array<{ topic: string }>>(
        `blocked_topics?topic=eq.${encodeURIComponent(normalized)}&blocked_at=not.is.null&select=topic&limit=1`,
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async unblockTopic(topic: string): Promise<void> {
    const normalized = topic.trim().toLowerCase();
    try {
      await this.request(`blocked_topics?topic=eq.${encodeURIComponent(normalized)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ blocked_at: null, unblock_after: null }),
      });
    } catch {
      // Non-fatal
    }
  }

  // ─── Daily summary log ───

  async hasDailySummaryBeenSent(date: string): Promise<boolean> {
    try {
      const rows = await this.request<Array<{ id: string }>>(
        `daily_summary_log?summary_date=eq.${date}&select=id&limit=1`,
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async logDailySummary(entry: {
    summary_date: string;
    posts_count: number;
    total_likes: number;
    total_retweets: number;
    total_replies: number;
  }): Promise<void> {
    try {
      await this.request("daily_summary_log", {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ ...entry, sent_at: new Date().toISOString() }),
      });
    } catch {
      // Non-fatal
    }
  }
}

