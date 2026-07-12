import type { Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { getFreeModels } from "./openrouter";

function cleanContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

export interface ImageResult {
  success: boolean;
  imagePath: string | null;
  imageUrl: string | null;
}

export interface AttachResult {
  success: boolean;
  error: string | null;
}

export async function generateImagePrompt(apiKey: string, postText: string): Promise<string> {
  const models = await getFreeModels(apiKey);
  const systemPrompt = `You generate image prompts for memes and illustrations that accompany X/Twitter posts. The image should make the post funnier, more shareable, or more eye-catching. Return ONLY the image prompt text — no JSON, no explanation, no quotes. Keep it under 200 words. Be specific about style (meme, illustration, photo, cartoon), subject, and mood.`;

  const userPrompt = `Generate an image prompt for a meme or illustration that pairs with this X post:

"${postText}"

Requirements:
- The image should amplify the joke or point of the post
- Prefer meme style, cartoon, or bold illustration over realistic stock photos
- Be specific about what's in the image
- No text in the image (the post has the text)
- Return ONLY the prompt text, nothing else`;

  const errors: string[] = [];
  for (const model of models) {
    console.log(`[Images] Using model for prompt: ${model}`);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://github.com/Abhi-Ray/x-social-agent",
        "x-title": "X Social Agent",
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 300,
        reasoning: { effort: "none" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (response.status === 402 || response.status === 429 || response.status >= 500) {
      errors.push(`${model}: HTTP ${response.status}`);
      continue;
    }
    if (!response.ok) {
      errors.push(`${model}: HTTP ${response.status}`);
      continue;
    }

    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      errors.push(`${model}: invalid API response`);
      continue;
    }

    let content = body.choices?.[0]?.message?.content;
    if (content) content = cleanContent(content);
    if (!content) {
      errors.push(`${model}: empty response`);
      continue;
    }

    return content.trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`All free OpenRouter models failed for image prompt: ${errors.slice(-6).join("; ")}`);
}

export async function generateImage(prompt: string): Promise<ImageResult> {
  const imagesDir = path.resolve(process.cwd(), "generated_images");
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const encodedPrompt = encodeURIComponent(prompt);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
  const timestamp = Date.now();
  const imagePath = path.join(imagesDir, `${timestamp}.png`);

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return { success: false, imagePath: null, imageUrl };
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(imagePath, buffer);
    console.log(`[Images] Saved image to ${imagePath}`);
    return { success: true, imagePath, imageUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Images] Failed to download image: ${message}`);
    return { success: false, imagePath: null, imageUrl };
  }
}

export async function attachImageToPost(page: Page, imagePath: string): Promise<AttachResult> {
  if (!fs.existsSync(imagePath)) {
    return { success: false, error: `Image file not found: ${imagePath}` };
  }

  try {
    // X uses a hidden file input for media uploads in the compose dialog
    const mediaInputSelectors = [
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ];

    let inputHandle = null;
    for (const selector of mediaInputSelectors) {
      inputHandle = await page.$(selector).catch(() => null);
      if (inputHandle) break;
    }

    if (!inputHandle) {
      return { success: false, error: "Could not find media file input on compose dialog" };
    }

    await inputHandle.setInputFiles(imagePath);
    // Wait for the image to upload — X shows a preview after upload
    await page.waitForTimeout(3000);

    // Verify the image preview appeared
    const preview = await page.$('[data-testid="attachments"] img, [data-testid="imagePreview"] img').catch(() => null);
    if (!preview) {
      await page.waitForTimeout(2000);
    }

    return { success: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

export function shouldGenerateImage(
  postText: string,
  engagementHistory: Array<{ posted_text: string; engagement_likes: number | null; has_image?: boolean }>,
): boolean {
  const text = postText.trim();
  const lower = text.toLowerCase();

  if (text.length < 30) return false;

  if (text.split("\n").length > 4) return false;

  const visualKeywords = [
    "chart", "graph", "meme", "photo", "picture", "look at this",
    "imagine", "visualize", "see this", "screenshot",
  ];
  if (visualKeywords.some((kw) => lower.includes(kw))) return true;

  const hotTakePatterns = [
    /^hot take/i,
    /^unpopular opinion/i,
    /^nobody talks about/i,
    /^the truth about/i,
    /^stop doing/i,
    /^most people/i,
    /^here's why/i,
    /^this is why/i,
  ];
  if (hotTakePatterns.some((p) => p.test(text))) return true;

  const recentWithImages = engagementHistory.filter((p) => p.has_image);
  if (recentWithImages.length >= 2) {
    const recent = engagementHistory.slice(0, 3);
    if (recent.filter((p) => p.has_image).length >= 2) return false;
  }

  const trendKeywords = ["trending", "breaking", "just happened", "update", "news"];
  if (trendKeywords.some((kw) => lower.includes(kw))) return true;

  const jokePatterns = [
    /^(lol|lmao|rofl)/i,
    /\b(joke|joking|kidding)\b/i,
  ];
  if (jokePatterns.some((p) => p.test(text)) && text.length < 80) return false;

  if (text.endsWith("?") && text.length < 60) return false;

  return false;
}
