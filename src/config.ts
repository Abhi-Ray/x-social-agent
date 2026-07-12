import type { Env } from "./types";

export function loadEnv(): Env {
  const required = [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHAT_IDS", "TELEGRAM_ALLOWED_USER_IDS",
    "TELEGRAM_TARGET_CHAT_ID", "OPENROUTER_API_KEY", "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}. Copy .env.example to .env and fill in values.`);
  return {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
    TELEGRAM_ALLOWED_CHAT_IDS: process.env.TELEGRAM_ALLOWED_CHAT_IDS!,
    TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS!,
    TELEGRAM_TARGET_CHAT_ID: process.env.TELEGRAM_TARGET_CHAT_ID!,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    STORAGE_STATE_PATH: process.env.STORAGE_STATE_PATH ?? "./storageState.json",
    X_HANDLE: process.env.X_HANDLE ?? "",
    CRON_INTERVAL_MINUTES: process.env.CRON_INTERVAL_MINUTES ?? "45",
  };
}

export const DAILY_CAPS = {
  original_post: Number(process.env.DAILY_CAP_ORIGINAL_POST) || 6,
  retweet_comment: Number(process.env.DAILY_CAP_RETWEET_COMMENT) || 4,
  reply: Number(process.env.DAILY_CAP_REPLY) || 5,
  mention: Number(process.env.DAILY_CAP_MENTION) || 3,
} as const;

export const MIN_GAP_SECONDS = Number(process.env.MIN_GAP_SECONDS) || 180;
export const JITTER_SECONDS = Number(process.env.JITTER_SECONDS) || 90;

export const MAX_DRAFTS_PER_TICK = 3;
export const CONTEXT_POSTS_COUNT = 20;
export const CONTEXT_TRENDS_DAYS = 3;
export const CONTEXT_QUOTES_SAMPLE = 15;
export const TREND_CACHE_HOURS = 1;

export function localDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Get current hour in IST (0-23)
export function getISTHour(): number {
  const istTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return parseInt(istTime, 10);
}

// Quiet hours: 12 AM (midnight) to 7 AM IST — no posts, no drafts
// Active hours: 7 AM to 11:59 PM IST
export const QUIET_START_HOUR = 0; // 12 AM IST
export const QUIET_END_HOUR = 7;   // 7 AM IST

export function isQuietHours(): boolean {
  const hour = getISTHour();
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hashText(text: string): string {
  let hash = 0;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `h${Math.abs(hash).toString(16)}`;
}

export function similarity(a: string, b: string): number {
  const na = new Set(a.trim().toLowerCase().split(/\s+/));
  const nb = new Set(b.trim().toLowerCase().split(/\s+/));
  const intersection = [...na].filter((w) => nb.has(w)).length;
  const union = new Set([...na, ...nb]).size;
  return union === 0 ? 0 : intersection / union;
}
