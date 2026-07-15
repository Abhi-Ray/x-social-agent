-- Migration 0003: Rejection learning + blocked topics + daily engagement summary tracking

-- Track each rejection with the draft text, trend topic, and style characteristics
-- This lets the system learn what styles/topics the user doesn't like
create table if not exists rejection_log (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid references drafts(id) on delete cascade,
  draft_text text not null,
  trend_topic text,
  action_type text,
  rejected_at timestamptz not null default now(),
  -- Style characteristics extracted from the rejected draft
  is_critical boolean default false,
  is_positive boolean default false,
  is_sarcastic boolean default false,
  is_long_form boolean default false,
  word_count integer default 0
);

create index if not exists rejection_log_rejected_at_idx on rejection_log(rejected_at desc);
create index if not exists rejection_log_trend_topic_idx on rejection_log(trend_topic);

-- Topics that have been rejected multiple times and should be blocked
create table if not exists blocked_topics (
  id uuid primary key default gen_random_uuid(),
  topic text not null unique,
  rejection_count integer not null default 0,
  first_rejected_at timestamptz not null default now(),
  last_rejected_at timestamptz not null default now(),
  blocked_at timestamptz, -- when it crossed the threshold (null = not yet blocked)
  unblock_after timestamptz -- optional: auto-unblock after this time
);

create index if not exists blocked_topics_topic_idx on blocked_topics(topic);
create index if not exists blocked_topics_blocked_at_idx on blocked_topics(blocked_at);

-- Track when the last daily engagement summary was sent
-- (so we send it once per day, not on every tick)
create table if not exists daily_summary_log (
  id uuid primary key default gen_random_uuid(),
  summary_date date not null unique,
  sent_at timestamptz not null default now(),
  posts_count integer default 0,
  total_likes integer default 0,
  total_retweets integer default 0,
  total_replies integer default 0
);

create index if not exists daily_summary_log_date_idx on daily_summary_log(summary_date desc);
