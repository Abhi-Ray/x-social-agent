import type { Env, Draft, TelegramUpdate } from "./types";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function b(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

function numericSet(value: string): Set<string> {
  return new Set(value.split(",").map((e) => e.trim()).filter((e) => /^-?\d+$/.test(e)));
}

export function isAllowedPrincipal(env: Env, chatId: number, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return numericSet(env.TELEGRAM_ALLOWED_CHAT_IDS).has(String(chatId)) && numericSet(env.TELEGRAM_ALLOWED_USER_IDS).has(String(userId));
}

export async function sendTelegram(env: Env, text: string, chatId?: string): Promise<void> {
  const targetChat = chatId ?? env.TELEGRAM_TARGET_CHAT_ID;
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? ["No content."];
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: targetChat, text: chunk, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!response.ok) {
      // Fallback: strip HTML
      const fallback = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: targetChat, text: chunk.replace(/<[^>]+>/g, ""), disable_web_page_preview: true }),
      });
      if (!fallback.ok) throw new Error(`Telegram ${fallback.status}: ${(await fallback.text()).slice(0, 300)}`);
    }
  }
}

export async function sendDraftForApproval(env: Env, draft: Draft): Promise<number | null> {
  const typeLabel: Record<string, string> = {
    original_post: "Original Post",
    reply: "Reply",
    retweet_comment: "Retweet w/ Comment",
    mention: "Mention",
  };

  const parts: string[] = [
    b(`Draft — ${typeLabel[draft.action_type] ?? draft.action_type}`),
    "",
    escapeHtml(draft.draft_text),
  ];

  if (draft.source_tweet_url) {
    parts.push("", `${b("Source:")} ${escapeHtml(draft.source_tweet_author ?? "unknown")}`);
    parts.push(escapeHtml(draft.source_tweet_text ?? ""));
    parts.push(draft.source_tweet_url);
  }

  if (draft.trend_topic) {
    parts.push("", `${b("Trend:")} ${escapeHtml(draft.trend_topic)}`);
  }

  if (draft.quote_text && draft.quote_attributed_to) {
    parts.push("", `${b("Quote:")} "${escapeHtml(draft.quote_text)}" — ${escapeHtml(draft.quote_attributed_to)}`);
    if (draft.quote_source) parts.push(`${b("Source:")} ${escapeHtml(draft.quote_source)}`);
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_TARGET_CHAT_ID,
      text: parts.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `approve:${draft.id}` },
            { text: "Edit", callback_data: `edit:${draft.id}` },
            { text: "Reject", callback_data: `reject:${draft.id}` },
          ],
        ],
      },
    }),
  });

  if (!response.ok) throw new Error(`Telegram sendMessage ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { result?: { message_id?: number } };
  return body?.result?.message_id ?? null;
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text ?? "OK" }),
  });
}

export async function editMessageText(env: Env, chatId: string, messageId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

export async function editMessageReplyMarkup(env: Env, chatId: string, messageId: number, replyMarkup: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
  });
}

export async function getUpdates(env: Env, offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams({ timeout: String(timeout) });
  if (offset) params.set("offset", String(offset));
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?${params}`);
  if (!response.ok) throw new Error(`Telegram getUpdates ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { result?: TelegramUpdate[] };
  return (body?.result ?? []) as TelegramUpdate[];
}

export async function sendDailySummary(env: Env, summary: {
  posts: number;
  replies: number;
  retweets: number;
  mentions: number;
  challenges: number;
  failures: number;
}): Promise<void> {
  const text = [
    b("Daily Summary"),
    "",
    `Original posts: ${summary.posts}`,
    `Replies: ${summary.replies}`,
    `Retweet+comments: ${summary.retweets}`,
    `Mentions: ${summary.mentions}`,
    `Challenges hit: ${summary.challenges}`,
    `Failures: ${summary.failures}`,
  ].join("\n");
  await sendTelegram(env, text);
}
