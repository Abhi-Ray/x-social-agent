import { config } from "dotenv";
config();

const apiKey = process.env.OPENROUTER_API_KEY!;

async function testModel(model: string): Promise<void> {
  console.log(`\nTesting: ${model}`);
  try {
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
        temperature: 0.7,
        max_tokens: 500,
        messages: [
          { role: "system", content: "You are a witty social media writer. Be positive and celebratory." },
          { role: "user", content: 'Write a short tweet celebrating ISRO landing on the moon. Return ONLY the tweet text, no JSON, no explanation.' },
        ],
      }),
    });

    console.log(`  Status: ${response.status}`);
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log(`  Error: ${errText.slice(0, 200)}`);
      return;
    }

    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content?.trim();
    console.log(`  Response: "${content?.slice(0, 200)}"`);
  } catch (e) {
    console.log(`  Exception: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  const models = [
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "openai/gpt-oss-120b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "google/gemma-4-31b-it:free",
    "tencent/hy3:free",
  ];

  for (const model of models) {
    await testModel(model);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch(console.error);
