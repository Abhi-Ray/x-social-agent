-- ─── Advanced features tables ───

-- Thread drafts (multi-tweet threads)
create table if not exists thread_drafts (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  tweets jsonb not null, -- array of {text, position}
  status text not null default 'pending_approval', -- pending_approval, approved, rejected, posted
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  thread_url text,
  engagement_likes int,
  engagement_retweets int,
  engagement_replies int
);

-- Followed accounts (for auto-follow growth)
create table if not exists followed_accounts (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  name text,
  category text, -- influencer, journalist, politician, tech, finance, etc.
  followers_count int,
  followed_at timestamptz not null default now(),
  follows_back boolean default false,
  unfollowed_at timestamptz
);

-- Best time to post — engagement by hour
create table if not exists engagement_by_hour (
  id uuid primary key default gen_random_uuid(),
  hour_ist int not null, -- 0-23
  avg_likes numeric default 0,
  avg_retweets numeric default 0,
  avg_replies numeric default 0,
  post_count int default 0,
  total_engagement numeric default 0,
  unique_date date,
  created_at timestamptz not null default now(),
  unique(hour_ist, unique_date)
);

-- A/B test variants
create table if not exists ab_test_variants (
  id uuid primary key default gen_random_uuid(),
  test_group text not null, -- group identifier for the test
  variant_label char(1) not null, -- 'A' or 'B'
  draft_text text not null,
  posted_at timestamptz,
  x_post_url text,
  engagement_likes int default 0,
  engagement_retweets int default 0,
  engagement_replies int default 0,
  winner boolean default false,
  created_at timestamptz not null default now()
);

-- Sentiment tracking on replies
create table if not exists reply_sentiment (
  id uuid primary key default gen_random_uuid(),
  post_url text not null,
  reply_text text,
  reply_author text,
  sentiment text not null, -- positive, negative, neutral
  sentiment_score numeric, -- -1.0 to 1.0
  created_at timestamptz not null default now()
);

-- Competitor tracking — viral posts from accounts we learn from
create table if not exists competitor_posts (
  id uuid primary key default gen_random_uuid(),
  handle text not null,
  post_text text not null,
  post_url text,
  likes int default 0,
  retweets int default 0,
  replies int default 0,
  topic text,
  scraped_at timestamptz not null default now(),
  learned_pattern text -- what made this viral (template/pattern extracted)
);

-- Viral template library — patterns from our own + competitor viral posts
create table if not exists viral_templates (
  id uuid primary key default gen_random_uuid(),
  template_text text not null, -- the pattern, e.g. "Nobody is going to tell you this: [INSIGHT]"
  source text, -- 'own' or competitor handle
  avg_engagement numeric default 0,
  times_used int default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- New followers tracking (for auto-DM)
create table if not exists new_followers (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  name text,
  followed_us_at timestamptz not null default now(),
  dm_sent boolean default false,
  dm_sent_at timestamptz
);

-- Hashtag performance tracking
create table if not exists hashtag_performance (
  id uuid primary key default gen_random_uuid(),
  hashtag text not null,
  post_url text,
  likes int default 0,
  retweets int default 0,
  replies int default 0,
  used_at timestamptz not null default now()
);

-- Content pillars — topic rotation tracking
create table if not exists content_pillar_log (
  id uuid primary key default gen_random_uuid(),
  pillar text not null, -- finance, tech, philosophy, sports, politics, culture, india_specific
  used_at timestamptz not null default now(),
  post_url text,
  engagement_score numeric default 0
);

-- Mention/reply queue — people who mentioned us
create table if not exists mention_queue (
  id uuid primary key default gen_random_uuid(),
  author_handle text not null,
  author_name text,
  tweet_url text not null,
  tweet_text text,
  replied_at timestamptz,
  auto_replied boolean default false,
  created_at timestamptz not null default now()
);

-- Trend predictions — emerging topics before they peak
create table if not exists trend_predictions (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  predicted_at timestamptz not null default now(),
  trended_at timestamptz, -- when it actually trended (null if not yet)
  prediction_score numeric, -- confidence 0-1
  posted boolean default false,
  post_url text
);

-- Cross-post log
create table if not exists cross_post_log (
  id uuid primary key default gen_random_uuid(),
  source_post_url text not null,
  platform text not null, -- 'threads', 'linkedin'
  cross_posted_at timestamptz not null default now(),
  external_url text,
  success boolean default false
);

-- Image generation log
create table if not exists generated_images (
  id uuid primary key default gen_random_uuid(),
  post_url text,
  prompt text not null,
  image_url text,
  image_path text,
  created_at timestamptz not null default now(),
  used boolean default false
);
