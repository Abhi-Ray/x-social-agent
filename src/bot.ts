import type { Env, TelegramUpdate } from "./types";
import { SupabaseClient } from "./supabase";
import { answerCallbackQuery, editMessageText, editMessageReplyMarkup, sendTelegram, isAllowedPrincipal, escapeHtml, b } from "./telegram";

// Track drafts awaiting edit text from user
// In production, store this in Supabase or a temp table; for simplicity, use a Map
const pendingEdits = new Map<string, { draftId: string; chatId: string; messageId: number }>();

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate, db: SupabaseClient): Promise<void> {
  // Handle callback query (button press)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message.chat.id);
    const userId = cq.from.id;
    const messageId = cq.message.message_id;
    const data = cq.data;

    if (!isAllowedPrincipal(env, Number(chatId), userId)) {
      await answerCallbackQuery(env, cq.id, "Not authorized.");
      return;
    }

    const [action, draftId] = data.split(":");

    if (action === "approve") {
      await handleApprove(env, db, draftId ?? "", chatId, messageId, cq.id);
    } else if (action === "reject") {
      await handleReject(env, db, draftId ?? "", chatId, messageId, cq.id);
    } else if (action === "edit") {
      await handleEdit(env, db, draftId ?? "", chatId, messageId, cq.id);
    }
    return;
  }

  // Handle text message (edit response or commands)
  if (update.message) {
    const msg = update.message;
    const chatId = String(msg.chat.id);
    const userId = msg.from?.id;

    if (!isAllowedPrincipal(env, Number(chatId), userId)) return;

    const text = msg.text?.trim() ?? "";

    // Commands
    if (text.startsWith("/")) {
      await handleCommand(env, db, text, chatId);
      return;
    }

    // Check if this is an edit response (user was asked to send their version)
    const editKey = `${chatId}:${msg.reply_to_message?.message_id ?? "none"}`;
    const pendingEdit = pendingEdits.get(editKey) ?? pendingEdits.get(chatId);
    if (pendingEdit) {
      const draft = await db.getDraftById(pendingEdit.draftId);
      if (draft && draft.status === "pending_approval") {
        await db.updateDraftText(draft.id, text);
        // Re-show with Approve/Reject
        const parts = [
          b("Edited Draft"),
          "",
          escapeHtml(text),
        ];
        if (draft.trend_topic) parts.push("", `${b("Trend:")} ${escapeHtml(draft.trend_topic)}`);
        await editMessageText(env, chatId, pendingEdit.messageId, parts.join("\n"));
        await editMessageReplyMarkup(env, chatId, pendingEdit.messageId, {
          inline_keyboard: [[
            { text: "Approve", callback_data: `approve:${draft.id}` },
            { text: "Reject", callback_data: `reject:${draft.id}` },
          ]],
        });
        pendingEdits.delete(editKey);
        pendingEdits.delete(chatId);
        await sendTelegram(env, "Draft updated. Approve or Reject above.", chatId);
      }
      return;
    }
  }
}

async function handleApprove(env: Env, db: SupabaseClient, draftId: string, chatId: string, messageId: number, callbackId: string): Promise<void> {
  const draft = await db.getDraftById(draftId);
  if (!draft) {
    await answerCallbackQuery(env, callbackId, "Draft not found.");
    return;
  }
  if (draft.status !== "pending_approval") {
    await answerCallbackQuery(env, callbackId, `Already ${draft.status}.`);
    return;
  }

  await db.updateDraftStatus(draftId, "approved", { approved_at: new Date().toISOString() });
  await db.createPendingAction(draftId);

  // Update the message to show it's approved
  await editMessageReplyMarkup(env, chatId, messageId, {
    inline_keyboard: [[{ text: "Approved — queued for posting", callback_data: "noop" }]],
  });
  await answerCallbackQuery(env, callbackId, "Approved. Will be posted with human-paced delay.");
}

async function handleReject(env: Env, db: SupabaseClient, draftId: string, chatId: string, messageId: number, callbackId: string): Promise<void> {
  const draft = await db.getDraftById(draftId);
  if (!draft) {
    await answerCallbackQuery(env, callbackId, "Draft not found.");
    return;
  }

  await db.updateDraftStatus(draftId, "rejected", { rejected_at: new Date().toISOString() });

  await editMessageReplyMarkup(env, chatId, messageId, {
    inline_keyboard: [[{ text: "Rejected", callback_data: "noop" }]],
  });
  await answerCallbackQuery(env, callbackId, "Rejected.");
}

async function handleEdit(env: Env, db: SupabaseClient, draftId: string, chatId: string, messageId: number, callbackId: string): Promise<void> {
  const draft = await db.getDraftById(draftId);
  if (!draft) {
    await answerCallbackQuery(env, callbackId, "Draft not found.");
    return;
  }

  // Track that we're waiting for edit text from this chat
  pendingEdits.set(chatId, { draftId, chatId, messageId });

  await answerCallbackQuery(env, callbackId, "Send your edited version as a text message.");
  await sendTelegram(env, "Send your edited version as a reply to this message (or just send it in chat).", chatId);
}

async function handleCommand(env: Env, db: SupabaseClient, text: string, chatId: string): Promise<void> {
  const cmd = text.toLowerCase().trim();

  if (cmd === "/help" || cmd === "/start") {
    await sendTelegram(env, [
      b("X Social Agent — Commands"),
      "",
      "Approve/Edit/Reject drafts via inline buttons.",
      "",
      "/help — this message",
      "/status — current daily counters and pending actions",
      "/pending — list drafts awaiting approval",
      "/posts — list recent posts with delete links",
      "/delete <url> — delete a post by its X URL",
      "/undo-retweet <url> — undo a retweet by its X URL",
      "/health — account health log",
      "",
      "Send plain text to edit a draft (after tapping Edit).",
    ].join("\n"), chatId);
  } else if (cmd === "/status") {
    const today = getLocalDate();
    const counter = await db.getDailyCounter(today);
    const pending = await db.getPendingActions();
    const parts = [
      b("Status"),
      "",
      `Date: ${today}`,
      `Original posts: ${counter?.original_post ?? 0}`,
      `Replies: ${counter?.reply ?? 0}`,
      `Retweet+comments: ${counter?.retweet_comment ?? 0}`,
      `Mentions: ${counter?.mention ?? 0}`,
      `Pending actions (queued): ${pending.length}`,
    ];
    await sendTelegram(env, parts.join("\n"), chatId);
  } else if (cmd === "/pending") {
    const drafts = await db.getRecentDrafts(10);
    const pending = drafts.filter((d) => d.status === "pending_approval");
    if (!pending.length) {
      await sendTelegram(env, "No drafts pending approval.", chatId);
    } else {
      const parts = [b("Pending Drafts"), ""];
      for (const d of pending) {
        parts.push(`[${d.action_type}] ${d.draft_text}`);
        parts.push("");
      }
      await sendTelegram(env, parts.join("\n"), chatId);
    }
  } else if (cmd === "/health") {
    const today = getLocalDate();
    const recent = await db.getRecentTrends(1); // placeholder — would query health log
    await sendTelegram(env, [b("Account Health"), "", `Today: ${today}`, "Use Supabase dashboard for detailed health logs."].join("\n"), chatId);
  } else if (cmd === "/posts") {
    // List recent posts for deletion
    const posts = await db.getRecentPosts(10);
    if (!posts.length) {
      await sendTelegram(env, "No posts yet.", chatId);
    } else {
      const parts = [b("Recent Posts (tap to delete)"), ""];
      for (const p of posts) {
        const age = Math.round((Date.now() - new Date(p.posted_at).getTime()) / 3_600_000);
        const preview = p.posted_text.slice(0, 60) + (p.posted_text.length > 60 ? "..." : "");
        parts.push(`${escapeHtml(preview)} (${age}h ago)`);
        if (p.x_post_url) parts.push(`Delete: /delete ${escapeHtml(p.x_post_url)}`);
        parts.push("");
      }
      await sendTelegram(env, parts.join("\n"), chatId);
    }
  } else if (cmd.startsWith("/delete ")) {
    const url = text.slice(8).trim();
    if (!url || !url.includes("x.com")) {
      await sendTelegram(env, "Usage: /delete <tweet URL>", chatId);
      return;
    }
    await sendTelegram(env, b(`Deleting post: ${url}`), chatId);
    try {
      const { launchSession, closeSession } = await import("./session");
      const { deletePost } = await import("./executor");
      const { browser, page } = await launchSession(true);
      try {
        const result = await deletePost(page, url);
        if (result.success) {
          await sendTelegram(env, b("Post deleted successfully."), chatId);
        } else if (result.challenge) {
          await sendTelegram(env, b(`ALERT: Challenge detected while deleting. Stopping. ${result.error}`), chatId);
        } else {
          await sendTelegram(env, b(`Delete failed: ${result.error}`), chatId);
        }
      } finally {
        await closeSession(browser);
      }
    } catch (error) {
      await sendTelegram(env, b(`Delete error: ${error instanceof Error ? error.message : String(error)}`), chatId);
    }
  } else if (cmd.startsWith("/undo-retweet ")) {
    const url = text.slice(14).trim();
    if (!url || !url.includes("x.com")) {
      await sendTelegram(env, "Usage: /undo-retweet <tweet URL>", chatId);
      return;
    }
    await sendTelegram(env, b(`Undoing retweet: ${url}`), chatId);
    try {
      const { launchSession, closeSession } = await import("./session");
      const { undoRetweet } = await import("./executor");
      const { browser, page } = await launchSession(true);
      try {
        const result = await undoRetweet(page, url);
        if (result.success) {
          await sendTelegram(env, b("Retweet undone successfully."), chatId);
        } else if (result.challenge) {
          await sendTelegram(env, b(`ALERT: Challenge detected. Stopping. ${result.error}`), chatId);
        } else {
          await sendTelegram(env, b(`Undo failed: ${result.error}`), chatId);
        }
      } finally {
        await closeSession(browser);
      }
    } catch (error) {
      await sendTelegram(env, b(`Undo error: ${error instanceof Error ? error.message : String(error)}`), chatId);
    }
  }
}

function getLocalDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
