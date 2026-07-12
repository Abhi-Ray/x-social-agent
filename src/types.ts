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

export interface ContextWindow {
  recent_posts: PostedContent[];
  recent_trends: TrendingTopic[];
  recent_drafts: Draft[];
  today_counters: DailyCounter | null;
  verified_quotes_sample: VerifiedQuote[];
  persona_summary: string;
}
