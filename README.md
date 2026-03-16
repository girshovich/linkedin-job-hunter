# Job Hunter

A self-hosted LinkedIn job search dashboard. Fetches jobs automatically, scores them with AI against your criteria, and surfaces only the strong matches — daily, in your inbox or on the web UI.

![Node.js](https://img.shields.io/badge/Node.js-22.5%2B-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)

---

## How it works

Each pipeline run (scheduled or manual):

1. **Fetch** — Apify scrapes LinkedIn for each Role's keywords × locations
2. **Title filter** — drops jobs whose title doesn't match your filter words
3. **Blacklist** — drops jobs from companies you've blocked
4. **Dedup** — skips jobs already seen in previous runs
5. **AI scoring** — GPT rates each job 0–100 against your prompt → Strong / Weak / No Match
6. **Dedup & summary** — checks for reposts, writes a one-paragraph summary for new strong matches
7. **Store** — saves everything locally (all verdicts)
8. **Email digest** — sends strong matches to your inbox (optional)

---

## Stack

- **Runtime** — Node.js 22.5+ / TypeScript
- **Web** — Express 4 + EJS + Tailwind CSS
- **Database** — SQLite via built-in `node:sqlite`
- **AI** — OpenAI Responses API (`gpt-5-mini` or `gpt-5.2`)
- **Scraping** — Apify (LinkedIn Jobs Scraper actor)
- **Email** — Resend
- **Scheduler** — node-cron (in-process)

---

## Setup

**1. Clone and install**
```bash
git clone https://github.com/girshovich/Job-Hunter.git
cd Job-Hunter
npm install
```

**2. Create `.env`**
```env
DASHBOARD_USER=admin
DASHBOARD_PASS=your_password

# Optional — API keys can also be set in the dashboard UI
APIFY_API_TOKEN=
OPENAI_API_KEY=
RESEND_API_KEY=
EMAIL_FROM=jobs@yourdomain.com
PORT=3000
```

`DASHBOARD_PASS` is required. All API keys can be entered in the Settings page instead of `.env`.

**3. Build and run**
```bash
npm run build
node dist/index.js
```

Open `http://localhost:3000` and follow the Getting Started checklist.

**To keep it running with PM2:**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

---

## API keys needed

| Service | Purpose | Free tier |
|---|---|---|
| [Apify](https://apify.com) | LinkedIn scraping | $5/mo credit on free plan |
| [OpenAI](https://platform.openai.com) | AI scoring & summaries | Pay as you go (~$0.50/day typical) |
| [Resend](https://resend.com) | Email digests | 100 emails/day free |

---

## Features

- **Roles** — multiple search profiles, each with its own keywords, locations, work modes, and AI prompt
- **Score thresholds** — configure what counts as Strong / Weak / No Match per Role
- **Title word filter** — narrow results without changing search keywords
- **Company blacklist** — permanently skip companies across all Roles
- **Jobs Match** — review strong matches, mark Applied, add notes, fix AI verdicts inline
- **Run Logs** — full audit log of every pipeline run
- **Analytics** — daily and monthly trend charts
- **Preflight checks** — validates config before running
