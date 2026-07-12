export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_CHAT_IDS: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  TELEGRAM_TARGET_CHAT_ID: string;
  OPENROUTER_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STORAGE_STATE_PATH: string;
  X_HANDLE: string;
  CRON_INTERVAL_MINUTES: string;
  THREADS_ACCESS_TOKEN?: string;
  THREADS_USER_ID?: string;
  LINKEDIN_ACCESS_TOKEN?: string;
}

export type ActionType = "original_post" | "reply" | "retweet_comment" | "mention";

export type DraftStatus = "pending_approval" | "approved" | "rejected" | "edited" | "expired";

export interface TrendingTopic {
  id: string;
  topic_text: string;
  scraped_at: string;
  category: string | null;
  used_count: number;
}

export interface Draft {
  id: string;
  action_type: ActionType;
  source_tweet_url: string | null;
  source_tweet_text: string | null;
  source_tweet_author: string | null;
  draft_text: string;
  status: DraftStatus;
  quote_text: string | null;
  quote_attributed_to: string | null;
  quote_source: string | null;
  trend_topic: string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  telegram_message_id: number | null;
}

export interface PendingAction {
  id: string;
  draft_id: string;
  approved_at: string;
  executed_at: string | null;
  result: "pending" | "success" | "failed" | "skipped_challenge" | null;
  error: string | null;
}

export interface PostedContent {
  id: string;
  text_hash: string;
  action_type: ActionType;
  posted_text: string;
  posted_at: string;
  x_post_url: string | null;
  engagement_likes: number | null;
  engagement_retweets: number | null;
  engagement_replies: number | null;
}

export interface DailyCounter {
  date: string;
  original_post: number;
  retweet_comment: number;
  reply: number;
  mention: number;
}

export interface AccountHealthLog {
  id: string;
  date: string;
  challenges_hit: number;
  failures: number;
  notes: string | null;
}

export interface VerifiedQuote {
  id: string;
  text: string;
  attributed_to: string;
  source_work: string;
  verified_by: string;
  verified_at: string;
  notes: string | null;
  times_used: number;
  last_used_at: string | null;
}

export interface GeneratedDraft {
  action_type: ActionType;
  draft_text: string;
  source_tweet_url: string | null;
  source_tweet_text: string | null;
  source_tweet_author: string | null;
  quote_text: string | null;
  quote_attributed_to: string | null;
  quote_source: string | null;
  trend_topic: string | null;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data: string;
    message: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    from: { id: number };
  };
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    reply_to_message?: { message_id: number; text?: string };
    from?: { id: number };
  };
}

export interface ABTestVariant {
  id: string;
  test_group: string;
  variant: "A" | "B";
  topic: string;
  text: string;
  engagement_likes: number | null;
  engagement_retweets: number | null;
  engagement_replies: number | null;
  is_winner: boolean | null;
  created_at: string;
  posted_at: string | null;
}

export interface ABVariantResult {
  variantA: string;
  variantB: string;
  topic: string;
}

export interface ThreadPostResult {
  success: boolean;
  threadUrl: string | null;
  error: string | null;
}

export interface ContextWindow {
  recent_posts: PostedContent[];
  recent_trends: TrendingTopic[];
  recent_drafts: Draft[];
  today_counters: DailyCounter | null;
  verified_quotes_sample: VerifiedQuote[];
  persona_summary: string;
}

export interface TrendPrediction {
  id: string;
  topic: string;
  prediction_score: number;
  current_engagement: number;
  growth_rate: number;
  predicted_at: string;
  trended_at: string | null;
  posted_at: string | null;
}

export interface EmergingTopic {
  topic: string;
  predictionScore: number;
  currentEngagement: number;
  growthRate: number;
}

export interface NewFollower {
  id: string;
  handle: string;
  name: string;
  first_seen_at: string;
  dm_sent: boolean;
  dm_sent_at: string | null;
}

export interface HashtagPerformance {
  id: string;
  hashtag: string;
  post_url: string | null;
  engagement: number;
  recorded_at: string;
}

export interface HashtagStat {
  hashtag: string;
  avg_engagement: number;
  total_posts: number;
}

export interface MentionQueueEntry {
  id: string;
  tweet_url: string;
  author_handle: string;
  author_name: string;
  tweet_text: string;
  replied: boolean;
  replied_at: string | null;
  first_seen_at: string;
}

export interface ScrapedMention {
  authorHandle: string;
  authorName: string;
  tweetUrl: string;
  tweetText: string;
}

export interface ScrapedFollower {
  handle: string;
  name: string;
}

export interface CrossPostLog {
  id: string;
  platform: "threads" | "linkedin";
  post_text: string;
  external_url: string | null;
  success: boolean;
  error: string | null;
  source_action_type: ActionType | null;
  source_post_url: string | null;
  posted_at: string;
}

export interface ContentPillarLog {
  id: string;
  pillar: string;
  post_url: string | null;
  engagement_score: number | null;
  used_at: string;
}

export interface PillarPerformance {
  pillar: string;
  total_posts: number;
  avg_engagement: number;
  last_used_at: string | null;
}

export interface ViralTemplate {
  id: string;
  template: string;
  pattern: string | null;
  source: string | null;
  avg_engagement: number | null;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
}
