import type { SupabaseClient } from "./supabase";
import type { ActionType } from "./types";

export interface CrossPostResult {
  success: boolean;
  externalUrl: string | null;
  error: string | null;
}

export interface CrossPostAllResult {
  threads: CrossPostResult;
  linkedin: CrossPostResult;
}

export async function crossPostToThreads(
  text: string,
  imagePath?: string,
): Promise<CrossPostResult> {
  const accessToken = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;
  if (!accessToken || !userId) {
    return { success: false, externalUrl: null, error: "Threads not configured" };
  }

  try {
    if (imagePath) {
      const mediaRes = await fetch(
        `https://graph.threads.net/v1.0/${userId}/threads`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            media_type: "IMAGE",
            image_url: imagePath,
            access_token: accessToken,
          }),
        },
      );
      if (!mediaRes.ok) {
        const errText = await mediaRes.text().catch(() => "");
        return { success: false, externalUrl: null, error: `Threads media create failed: ${mediaRes.status} ${errText.slice(0, 200)}` };
      }
      const mediaBody = await mediaRes.json() as { id: string };
      const createRes = await fetch(
        `https://graph.threads.net/v1.0/${userId}/threads_publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creation_id: mediaBody.id,
            text,
            access_token: accessToken,
          }),
        },
      );
      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        return { success: false, externalUrl: null, error: `Threads publish failed: ${createRes.status} ${errText.slice(0, 200)}` };
      }
      const createBody = await createRes.json() as { id: string; permalink?: string };
      return { success: true, externalUrl: createBody.permalink ?? `https://www.threads.net/@${userId}/post/${createBody.id}`, error: null };
    }

    const createRes = await fetch(
      `https://graph.threads.net/v1.0/${userId}/threads`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          media_type: "TEXT",
          text,
          access_token: accessToken,
        }),
      },
    );
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      return { success: false, externalUrl: null, error: `Threads create failed: ${createRes.status} ${errText.slice(0, 200)}` };
    }
    const createBody = await createRes.json() as { id: string };

    const publishRes = await fetch(
      `https://graph.threads.net/v1.0/${userId}/threads_publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creation_id: createBody.id,
          access_token: accessToken,
        }),
      },
    );
    if (!publishRes.ok) {
      const errText = await publishRes.text().catch(() => "");
      return { success: false, externalUrl: null, error: `Threads publish failed: ${publishRes.status} ${errText.slice(0, 200)}` };
    }
    const publishBody = await publishRes.json() as { id: string; permalink?: string };
    return { success: true, externalUrl: publishBody.permalink ?? `https://www.threads.net/@${userId}/post/${publishBody.id}`, error: null };
  } catch (err) {
    return { success: false, externalUrl: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function crossPostToLinkedIn(text: string): Promise<CrossPostResult> {
  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!accessToken) {
    return { success: false, externalUrl: null, error: "LinkedIn not configured" };
  }

  try {
    const personRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!personRes.ok) {
      const errText = await personRes.text().catch(() => "");
      return { success: false, externalUrl: null, error: `LinkedIn userinfo failed: ${personRes.status} ${errText.slice(0, 200)}` };
    }
    const personBody = await personRes.json() as { sub: string };

    const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-restli-protocol-version": "2.0",
      },
      body: JSON.stringify({
        author: `urn:li:person:${personBody.sub}`,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    if (!postRes.ok) {
      const errText = await postRes.text().catch(() => "");
      return { success: false, externalUrl: null, error: `LinkedIn post failed: ${postRes.status} ${errText.slice(0, 200)}` };
    }
    const postBody = await postRes.json() as { id: string };
    const externalUrl = `https://www.linkedin.com/feed/update/${postBody.id}`;
    return { success: true, externalUrl, error: null };
  } catch (err) {
    return { success: false, externalUrl: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function crossPostAll(
  text: string,
  imagePath?: string,
  db?: SupabaseClient,
  sourceActionType?: ActionType,
  sourcePostUrl?: string,
): Promise<CrossPostAllResult> {
  const [threads, linkedin] = await Promise.all([
    crossPostToThreads(text, imagePath),
    crossPostToLinkedIn(text),
  ]);

  if (db) {
    const logEntries = [
      { platform: "threads" as const, result: threads },
      { platform: "linkedin" as const, result: linkedin },
    ];
    for (const entry of logEntries) {
      try {
        await db.insertCrossPostLog({
          platform: entry.platform,
          post_text: text,
          external_url: entry.result.externalUrl,
          success: entry.result.success,
          error: entry.result.error,
          source_action_type: sourceActionType ?? null,
          source_post_url: sourcePostUrl ?? null,
        });
      } catch (logErr) {
        console.error(`[CrossPost] Failed to log ${entry.platform}: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
      }
    }
  }

  return { threads, linkedin };
}

export function shouldCrossPost(
  postText: string,
  engagement: { likes: number; retweets: number; replies: number },
): boolean {
  if (postText.trim().startsWith("@")) return false;
  if (postText.toLowerCase().startsWith("rt @")) return false;
  if (engagement.likes < 50) return false;
  return true;
}
