import { config } from "dotenv";
config();
import { SupabaseClient } from "../src/supabase";
import { generateHindiPost, shouldPostInHindi, translateToHinglish } from "../src/hindi";
import { shouldUseTemplate, getUnusedTemplate, fillTemplate } from "../src/viraltemplates";
import { generateThread } from "../src/threads";
import { generateABVariants } from "../src/abtest";
import { analyzeSentiment } from "../src/sentiment";
import { extractTemplate } from "../src/viraltemplates";
import { extractHashtags } from "../src/hashtags";
import { generateImagePrompt, generateImage, shouldGenerateImage } from "../src/images";
import { pickNextPillar, getPillarInstructions, CONTENT_PILLARS } from "../src/pillars";
import { suggestHashtags } from "../src/hashtags";
import type { Env } from "../src/types";

const env: Env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  TELEGRAM_ALLOWED_CHAT_IDS: process.env.TELEGRAM_ALLOWED_CHAT_IDS!,
  TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS!,
  TELEGRAM_TARGET_CHAT_ID: process.env.TELEGRAM_TARGET_CHAT_ID!,
  X_HANDLE: process.env.X_HANDLE!,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!, STORAGE_STATE_PATH: process.env.STORAGE_STATE_PATH ?? "storageState.json", CRON_INTERVAL_MINUTES: Number(process.env.CRON_INTERVAL_MINUTES ?? 45),
};

const db = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const apiKey = env.OPENROUTER_API_KEY;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log("=".repeat(60));
  try {
    await fn();
    console.log(`✓ ${name} — PASSED`);
  } catch (e) {
    console.log(`✗ ${name} — FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  // 1. Hindi post generation
  await test("Hindi Post Generation", async () => {
    const result = await generateHindiPost(apiKey, { recent_posts: [] }, "Indian cricket");
    console.log(`  Script: ${result.script}`);
    console.log(`  Text: "${result.text}"`);
    if (!result.text || result.text.length === 0) throw new Error("No text generated");
  });

  // 2. Should post in Hindi
  await test("Should Post in Hindi (rotation logic)", async () => {
    const result = await shouldPostInHindi(db, 10);
    console.log(`  Should post in Hindi: ${result}`);
  });

  // 3. Translate to Hinglish
  await test("Translate to Hinglish", async () => {
    const result = await translateToHinglish(apiKey, "The stock market is a wealth transfer machine from the impatient to the patient.");
    console.log(`  Hinglish: "${result}"`);
    if (!result) throw new Error("No translation");
  });

  // 4. Viral template — should use
  await test("Should Use Template", async () => {
    const result = await shouldUseTemplate(db);
    console.log(`  Should use template: ${result}`);
  });

  // 5. Viral template — get unused
  await test("Get Unused Template", async () => {
    const template = await getUnusedTemplate(db);
    if (template) {
      console.log(`  Template: "${template.template_text}"`);
      console.log(`  Source: ${template.source}, Times used: ${template.times_used}`);
    } else {
      console.log("  No unused templates available (will populate as competitor cloning runs)");
    }
  });

  // 6. Viral template — extract template
  await test("Extract Template from viral post", async () => {
    const result = extractTemplate("Nobody talks about how Indian startups burn cash like it's Diwali every quarter.");
    console.log(`  Template: "${result.template}"`);
    console.log(`  Pattern: "${result.pattern}"`);
  });

  // 7. Thread generation
  await test("Thread Generation (3-5 tweets)", async () => {
    const tweets = await generateThread(apiKey, { recent_posts: [], recent_trends: [], recent_drafts: [], today_counters: null, verified_quotes_sample: [], persona_summary: "" }, "Why Indian startups fail");
    console.log(`  Thread length: ${tweets.length} tweets`);
    for (let i = 0; i < tweets.length; i++) {
      console.log(`  Tweet ${i + 1}: "${tweets[i]!.slice(0, 80)}..."`);
    }
    if (tweets.length < 2) throw new Error("Thread too short");
  });

  // 8. A/B testing — generate variants
  await test("A/B Testing — Generate Variants", async () => {
    const result = await generateABVariants(apiKey, { recent_posts: [], recent_trends: [], recent_drafts: [], today_counters: null, verified_quotes_sample: [], persona_summary: "" }, "AI replacing jobs in India");
    console.log(`  Variant A: "${result.variantA}"`);
    console.log(`  Variant B: "${result.variantB}"`);
    if (!result.variantA || !result.variantB) throw new Error("Missing variants");
  });

  // 9. Sentiment analysis
  await test("Sentiment Analysis", async () => {
    const positive = analyzeSentiment("This is absolutely mast! Love it!");
    const negative = analyzeSentiment("This is terrible and feku. Worst take ever.");
    const neutral = analyzeSentiment("The stock market opened at 10 AM today.");
    console.log(`  Positive: ${positive.sentiment} (${positive.score})`);
    console.log(`  Negative: ${negative.sentiment} (${negative.score})`);
    console.log(`  Neutral: ${neutral.sentiment} (${neutral.score})`);
    if (positive.sentiment !== "positive") throw new Error("Positive sentiment not detected");
    if (negative.sentiment !== "negative") throw new Error("Negative sentiment not detected");
  });

  // 10. Content pillar — pick next
  await test("Content Pillar — Pick Next", async () => {
    const pillar = await pickNextPillar(db);
    console.log(`  Next pillar: ${pillar}`);
    const instructions = getPillarInstructions(pillar);
    console.log(`  Instructions: "${instructions.slice(0, 80)}..."`);
  });

  // 11. Content pillars — list all
  await test("Content Pillars — All Available", async () => {
    console.log(`  Available pillars: ${CONTENT_PILLARS.join(", ")}`);
  });

  // 12. Hashtag extraction
  await test("Hashtag Extraction", async () => {
    const tags = extractHashtags("This is a test #India #Tech #Startups post");
    console.log(`  Extracted: ${tags.join(", ")}`);
    if (tags.length !== 3) throw new Error("Should extract 3 hashtags");
  });

  // 13. Hashtag suggestions
  await test("Hashtag Suggestions", async () => {
    const suggestions = await suggestHashtags(db, "Indian cricket IPL");
    console.log(`  Suggestions: ${suggestions.length > 0 ? suggestions.join(", ") : "None yet (needs data)"}`);
  });

  // 14. Image — should generate
  await test("Image — Should Generate (decision logic)", async () => {
    const shouldForHotTake = shouldGenerateImage("Unpopular opinion: Indian startups are overvalued", []);
    const shouldForJoke = shouldGenerateImage("lol same", []);
    console.log(`  Hot take → should generate: ${shouldForHotTake}`);
    console.log(`  Short joke → should generate: ${shouldForJoke}`);
  });

  // 15. Image — generate prompt
  await test("Image — Generate Prompt", async () => {
    const prompt = await generateImagePrompt(apiKey, "Indian tech boom is real");
    console.log(`  Prompt: "${prompt}"`);
    if (!prompt) throw new Error("No prompt generated");
  });

  // 16. Image — generate actual image
  await test("Image — Generate Actual Image (Pollinations.ai)", async () => {
    const result = await generateImage("A billionaire looking at Mumbai skyline, digital art style");
    console.log(`  Success: ${result.success}`);
    console.log(`  Image path: ${result.imagePath}`);
    console.log(`  Image URL: ${result.imageUrl}`);
    if (!result.success) throw new Error(result.error ?? "Image generation failed");
  });

  // 17. Cross-posting — should cross-post
  await test("Cross-Posting — Should Cross-Post (decision)", async () => {
    const { shouldCrossPost } = await import("../src/crosspost");
    const shouldForHighEng = shouldCrossPost("Original post about India", { likes: 100, retweets: 20, replies: 10 });
    const shouldForReply = shouldCrossPost("@someone reply to you", { likes: 100, retweets: 20, replies: 10 });
    const shouldForLowEng = shouldCrossPost("Original post", { likes: 10, retweets: 2, replies: 1 });
    console.log(`  High engagement original → ${shouldForHighEng}`);
    console.log(`  Reply (even high eng) → ${shouldForReply}`);
    console.log(`  Low engagement → ${shouldForLowEng}`);
  });

  // 18. Database verification — competitor posts
  await test("DB: Competitor Posts", async () => {
    const posts = await db.getTopCompetitorPosts(3);
    console.log(`  Competitor posts in DB: ${posts.length}`);
    for (const p of posts) {
      console.log(`    @${p.handle}: "${p.post_text.slice(0, 60)}..." (${p.likes} likes)`);
    }
  });

  // 19. Database verification — followed accounts
  await test("DB: Followed Accounts", async () => {
    const { data } = await fetch(`${env.SUPABASE_URL}/rest/v1/followed_accounts?select=handle,category,followed_at&order=followed_at.desc&limit=5`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    }).then(r => r.json() as any);
    console.log(`  Followed accounts in DB: ${data?.length ?? 0}`);
    for (const a of data ?? []) {
      console.log(`    @${a.handle} (${a.category}) at ${a.followed_at}`);
    }
  });

  // 20. Database verification — viral templates
  await test("DB: Viral Templates", async () => {
    const templates = await db.getTopViralTemplates(3);
    console.log(`  Viral templates in DB: ${templates.length}`);
    for (const t of templates) {
      console.log(`    "${t.template_text}" (source: ${t.source}, used: ${t.times_used}x)`);
    }
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log("ALL FEATURE TESTS COMPLETE");
  console.log("=".repeat(60));
}

main().catch(console.error);
