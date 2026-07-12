# X Social Agent

An autonomous X/Twitter social agent with a billionaire-mindset persona, Telegram approval flow, and past-context-aware content generation. Runs on your own machine via Playwright — zero recurring cost.

## What it does

1. **Scrapes X trending topics** via a logged-in Playwright browser session
2. **Generates draft posts** using free OpenRouter models, with full past-context awareness (knows what it already posted, what trends it already covered, what's in the approval pipeline)
3. **Pushes drafts to Telegram** with inline Approve / Edit / Reject buttons
4. **Executes approved actions** via Playwright with human-paced delays, daily caps, and challenge detection
5. **Logs everything** to Supabase for health monitoring and dedup

## Persona

The agent posts as a persona with a **billionaire mindset and god complex** — sarcastic, funny, optimistic, atheist, no belief in social order, opinionated on every topic, no political bias, factually correct, and critical/logical. It thinks in historical analogies (Stoicism, Sun Tzu, Chanakya, the Gita's karma-yoga, Munger, Naval, Feynman, Sagan) and deploys verified quotes only. No real personal info is ever revealed.

See `X_AGENT_BUILD_SPEC.md` for the full persona spec and build rationale.

## Architecture

```
[Trending Scraper] → [Content Generator] → [Telegram Approval Queue] → [Action Executor] → [X, via Playwright]
   (Playwright)         (OpenRouter free       (Telegram Bot API,          (Playwright,            |
                         models, persona         inline buttons)            human-paced delays)    v
                         system prompt)                                                             [Supabase: logs,
                                                                                                      daily counters,
                                                                                                      content history,
                                                                                                      verified quotes]
```

## Prerequisites

- Node.js 20+
- A free [OpenRouter](https://openrouter.ai) account with a **separate API key** from any other project
- A free [Supabase](https://supabase.com) project (can be the same project as jarvis-assistant or a new one)
- A Telegram bot (create one via [@BotFather](https://t.me/BotFather))
- A real X/Twitter account you own

## Setup

### 1. Install dependencies

```sh
npm install
npx playwright install chromium
```

### 2. Configure environment

```sh
cp .env.example .env
```

Fill in `.env`:
- `TELEGRAM_BOT_TOKEN` — from @BotFather (create a **new bot**, don't reuse jarvis's)
- `TELEGRAM_ALLOWED_CHAT_IDS` / `TELEGRAM_ALLOWED_USER_IDS` — your numeric Telegram chat/user IDs (comma-separated)
- `TELEGRAM_TARGET_CHAT_ID` — where drafts are sent for approval
- `OPENROUTER_API_KEY` — a **separate key** from jarvis-assistant (different OpenRouter account recommended)
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from your Supabase project settings
- `X_HANDLE` — your X/Twitter handle (without @), used for scraping your own profile for context

### 3. Set up Supabase

Run `supabase/migrations/0001_initial.sql` in the Supabase SQL editor. This creates all tables with RLS locked to `service_role` only.

### 4. Seed verified quotes

```sh
npm run start -- seed-quotes
```

This inserts ~30 source-checked quotes (Stoicism, Sun Tzu, Chanakya, Gita, Munger, Naval, Feynman, Sagan, etc.) into the `verified_quotes` table. The generator only uses these exact quotes with attribution.

### 5. Capture X session

```sh
npm run login
```

This opens a real browser. Log in to X/Twitter manually, then press Enter in the terminal. The session is saved to `storageState.json` (gitignored — never commit this).

### 6. Run the agent

```sh
# Full cron mode: bot polling + periodic ticks + executor checks
npm start

# Or run individual components:
npm run run:tick        # Scrape trends + generate drafts + push to Telegram
npm run run:executor    # Execute approved actions
npm run run:bot         # Telegram bot polling only (approvals/rejections/edits)
```

## Commands

| Command | Description |
|---|---|
| `npm start` | Full cron mode — bot polling + periodic ticks + executor |
| `npm run login` | One-time manual X login + session capture |
| `npm run run:tick` | Single tick: scrape → generate → push to Telegram |
| `npm run run:executor` | Process approved actions via Playwright |
| `npm run run:bot` | Telegram bot polling (handle approvals/edits/rejections) |
| `npm run start -- seed-quotes` | Seed verified quotes into Supabase |
| `npm run start -- daily-summary` | Send daily summary to Telegram |
| `npm run typecheck` | TypeScript type checking |
| `npm run test` | Run tests |

## Telegram commands

Once the bot is running, you can use these in Telegram:

- `/help` — show available commands
- `/status` — current daily counters and pending actions
- `/pending` — list drafts awaiting approval
- `/health` — account health summary

For drafts, use the inline buttons: **Approve**, **Edit**, **Reject**. If you tap Edit, send your revised text as a plain message.

## Safety features

- **Daily caps** (configurable via env): 6 original posts, 4 retweet+comments, 5 replies, 3 mentions per day
- **Human-paced delays**: minimum 180s between actions ± 90s jitter (configurable)
- **Duplicate detection**: hash-check + word-similarity check against `posted_content`
- **Challenge detection**: if X shows a CAPTCHA/login/challenge page, the agent **stops immediately**, alerts on Telegram, and does not retry
- **Past-context awareness**: the generator sees your last 20 posts, recent trends, today's counters, and pending drafts — it will not repeat topics or angles
- **Verified quotes only**: the generator can only use quotes from the `verified_quotes` table with exact attribution

## Tech stack

| Piece | Tool |
|---|---|
| Browser automation | Playwright + `rebrowser-playwright` (stealth patches) |
| Content generation | OpenRouter free models (same discovery pattern as jarvis-assistant) |
| Approval + control | Telegram Bot API (polling-based for local execution) |
| Storage | Supabase (free tier) |
| Runtime | Node.js + tsx (TypeScript execution) |

## Relationship to jarvis-assistant

This project reuses patterns from the `jarvis-assistant` Cloudflare Worker:
- OpenRouter free-model discovery (`getFreeModels` with `preferredModels` array)
- Supabase REST client pattern (service_role key, RLS-locked tables)
- Telegram allowlist pattern (chat ID + user ID verification)
- JSON parsing and validation helpers

It uses a **separate OpenRouter API key** (different account recommended) to avoid rate-limit interference. The Telegram bot is also separate (new bot via @BotFather).

## Project structure

```
x-social-agent/
├── src/
│   ├── index.ts          # Entry point + CLI commands
│   ├── config.ts         # Env loading, rate-limit config, utilities
│   ├── types.ts          # TypeScript interfaces
│   ├── supabase.ts       # Supabase REST client
│   ├── openrouter.ts     # OpenRouter free-model client (separate key)
│   ├── persona.ts        # System prompt, context builder, verified quotes
│   ├── generator.ts      # Context-aware draft generation
│   ├── telegram.ts       # Telegram bot API helpers
│   ├── bot.ts            # Telegram update handler (approvals/edits/commands)
│   ├── session.ts        # Playwright session manager
│   ├── scraper.ts        # Trending + timeline scraper
│   ├── executor.ts       # Action executor (post/reply/retweet)
│   └── orchestrator.ts   # Tick + executor + bot polling loops
├── scripts/
│   └── login.ts          # One-time manual X login
├── supabase/
│   └── migrations/
│       └── 0001_initial.sql
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## License

Private project. Not for redistribution.
