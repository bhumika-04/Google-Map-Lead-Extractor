# Google Map Lead Extractor

A full-stack B2B lead generation system built as a **Chrome Extension (MV3)** with a local **ASP.NET API** and **MSSQL** backend. It automates lead discovery from Google Maps, enriches each lead through multi-source AI research, scrapes 6 months of social activity from LinkedIn/Twitter/Instagram to build intent signals, and tracks the full outreach conversation pipeline — all from a single dashboard.

Built specifically for Indian SMB sales teams. Supports IndiaMART, JustDial, Zaubacorp, and Interakt WhatsApp Business API out of the box.

---

## Features

### Lead Capture
- Searches Google Maps by city + keyword (e.g. "Packaging companies in Indore")
- Auto-scrolls results, captures every visible listing in real time
- Extracts: company name, address, phone, website, rating, reviews, category, Google Maps URL
- Real-time deduplication — skips leads already captured (matches by name, phone, or Maps URL)
- Live progress badge showing count during capture
- Save search queries as presets for repeat searches

### Lead Management
- Sortable, filterable table of all captured leads
- Status tracking: New → Selected / Rejected
- Notes and tags per lead
- Bulk actions: select all, tag, delete, export
- Export to **CSV** or **JSON**
- Filter by city, keyword, rating, phone availability, validation status

### AI Lead Validation
- Describe your business once in Settings (e.g. "We sell ERP to packaging manufacturers in India")
- One click validates all leads in batches — AI decides relevant or not
- Marks each lead with: `relevant` / `not_relevant` + reason
- Supports all three AI providers

### AI Research (Phase 2)
Runs one-click per lead (or auto-queues on capture). Pulls from:
- Company website (homepage + About / Team / Services / Products / Clients / Achievements pages)
- Google Search (3 targeted queries: overview, location, industry context)
- IndiaMART listing
- JustDial listing
- Zaubacorp, AmbitionBox, TradeIndia directories

Extracts and stores:
- Email, alternate phone, WhatsApp
- Social profiles: LinkedIn, Twitter, Facebook, Instagram, YouTube
- Decision maker name + LinkedIn profile
- Full team members with roles
- Industry, tagline, business type, supplier/buyer type
- Team size, year founded, annual turnover, headquarters
- Certifications, major clients, export markets
- Current software / tech stack
- Expansion signals, pain points
- Confidence score (0–100%)

Supports **3 AI providers**: Google Gemini (recommended), OpenAI GPT-4o, Anthropic Claude

### Evidence-Based Company Research (Phase 3)
Replaces the single-blob research call with an auditable, source-by-source pipeline:

1. Google-searches `"Company Name" "City"` and captures **every** result as `SearchEvidence` (title, url, snippet, rank, detected source type) — including rejected ones, with a reason
2. Classifies each link's domain into a type: official website, LinkedIn, Facebook, Instagram, YouTube, IndiaMART, TradeIndia, ZaubaCorp, AmbitionBox, company directory, review site
3. Scores each result's name-match confidence against the lead's company name and **rejects mismatched companies** before anything is opened — never assigns data from an unrelated company
4. Opens accepted links **one at a time** (priority order: official website → LinkedIn → IndiaMART → TradeIndia → Facebook → Instagram → ZaubaCorp/directory), with human-like pacing between visits
5. Runs a separate AI extraction call **per source page**, so every extracted field stays traceable to the exact page it came from
6. Merges all per-page extractions into one company profile, preferring the highest-confidence page for each field

Browse the full evidence trail — accepted/rejected search results, every page visited, and per-source extracted JSON — in the new **Company Intelligence** page. Export to CSV or JSON.

### Deep Research — Social Intelligence
Opens hidden background tabs using your logged-in browser session. No API keys or login bypass needed.

- Scrapes company LinkedIn `/people/` page → resolves individual team member profile URLs directly
- Scrolls **6 months of posts** per person (trips, achievements, hiring, opinions, announcements)
- Scrapes company Twitter/X account — 6 months of posts
- Scrapes company Instagram — bio + recent posts
- **Brand alias resolution**: "Pragati Graphics and Packaging Pvt Ltd" → website `pragatiglobal.com` → searches as "Pragati Global" so it finds the right profiles even when the company uses a short name publicly
- AI analysis of all collected activity generates:
  - **Intent signals** (e.g. "Hiring ERP consultant → tech upgrade in progress")
  - **Company signals** (e.g. "Posted about new pharma client win")
  - **Personalized pitch recommendation**
  - **Ready-to-send cold outreach template**

> You must be logged into LinkedIn and Twitter in Chrome for this to work.

### Outreach Pipeline
Track every conversation from first touch to close:

| Stage | Description |
|---|---|
| Cold | Lead identified, not yet contacted |
| Contacted | First message sent |
| Replied | Prospect replied |
| Nurturing | Ongoing conversation |
| Meeting Scheduled | Meeting confirmed |
| Won / Lost | Deal outcome |

Available channels per lead (based on what research found):
- **WhatsApp** — via Interakt Business API (auto-send template) or wa.me link (manual)
- **LinkedIn** — opens profile, user clicks Message
- **Email** — opens mailto with pre-filled subject + body
- **Instagram** — opens profile
- **Facebook** — opens profile

All sent messages and replies are logged to MSSQL with timestamps. Stage changes saved per conversation thread.

### WhatsApp via Interakt
- Add your Interakt API key + pre-approved template name in Settings
- System upserts the contact in Interakt (name, company, city, email) before sending
- Fills template body variables from research data: `{{1}}` contact name · `{{2}}` company · `{{3}}` intent signal · `{{4}}` pitch
- Falls back to wa.me link if Interakt is not configured

### Data Persistence — Survives Reinstall
- **MSSQL is the single source of truth**
- Every lead captured is synced to MSSQL in batches of 10
- Every research result is saved to MSSQL immediately on completion
- Every deep research result saved immediately on completion
- On dashboard open: pulls all leads + enrichments from MSSQL back into IndexedDB
- Full JSON backup also stored via API (additional fallback for offline scenarios)
- After sync, each lead gets `mssqlId` (UUID) written back — used to load conversation history

### Theme
- Dark mode (default) and light mode
- Toggle with the ☀/🌙 button in the top bar
- Preference saved across sessions

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                                     │
│                                                                     │
│  ┌──────────────────┐   ┌──────────────────┐   ┌────────────────┐  │
│  │   Dashboard UI   │   │ Service Worker   │   │ Content Script │  │
│  │ React + Zustand  │◄──│ (Background)     │──►│ mapsContent.ts │  │
│  │ Tailwind CSS     │   │ IndexedDB/Dexie  │   │ mapsExtractor  │  │
│  └────────┬─────────┘   └────────┬─────────┘   │ autoScroller   │  │
│           │                      │              └────────────────┘  │
│  ┌────────▼──────────────────────▼───────────────────────────────┐  │
│  │              Social Scraper (hidden tab + scripting API)       │  │
│  │     LinkedIn people/ page · individual profiles · Twitter ·    │  │
│  │     Instagram · 6-month scroll loop per person                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ HTTP  localhost:5150
                              ▼
┌──────────────────────────────────────────────────────────┐
│  DeepLeadApi  (ASP.NET 9 Minimal API + Dapper)           │
│                                                          │
│  /api/leads/save-batch   → batch upsert on capture       │
│  /api/sync               → full session sync + leadIdMap │
│  /api/research/save      → auto-called after AI research │
│  /api/deep-research/save → auto-called after deep scan   │
│  /api/outreach/*         → conversation tracking         │
│  /api/restore            → full restore on reinstall     │
│  /api/extension-backup   → JSON backup fallback          │
└─────────────────────────────┬────────────────────────────┘
                              │ Dapper
                              ▼
┌─────────────────────────────────────────┐
│  MSSQL  (SQL Server Express)            │
│                                         │
│  search_projects                        │
│  companies               (leads)        │
│  company_enrichments     (research)     │
│  company_contacts        (team members) │
│  company_deep_research   (social intel) │
│  search_evidence         (Google links) │
│  source_pages            (pages opened) │
│  company_research        (merged data)  │
│  outreach_conversations  (threads)      │
│  conversation_messages   (log)          │
│  nurture_templates                      │
│  nurture_sequences                      │
└─────────────────────────────────────────┘
```

**Tech Stack:**

| Layer | Technology |
|---|---|
| Extension UI | React 18, TypeScript, Tailwind CSS, Vite |
| State | Zustand |
| Local DB | Dexie.js (IndexedDB) |
| Extension platform | Chrome MV3 — service worker + content scripts |
| Backend API | ASP.NET 9 Minimal API |
| ORM | Dapper |
| Database | Microsoft SQL Server (Express is fine) |
| AI providers | Google Gemini, OpenAI GPT-4o, Anthropic Claude |
| WhatsApp | Interakt Business API |

---

## Project Structure

```
Google-Map-Lead-Extractor/
│
├── leadscout-ai-extension/            Chrome Extension (MV3)
│   ├── public/
│   │   ├── manifest.json              Permissions, content scripts, background
│   │   └── icons/                     16 / 48 / 128 px icons
│   └── src/
│       ├── background/
│       │   └── serviceWorker.ts       Central hub: capture, sync, research loop
│       ├── content/
│       │   ├── mapsContent.ts         Injected into Google Maps tabs
│       │   ├── mapsExtractor.ts       Parses Maps card DOM → Lead object
│       │   └── autoScroller.ts        Scroll algorithm with stop conditions
│       ├── dashboard/
│       │   ├── Dashboard.tsx          Shell layout + section routing
│       │   └── components/
│       │       ├── SearchConsole.tsx       Start a Maps search
│       │       ├── LeadTable.tsx           All leads — sort, filter, select, export
│       │       ├── LeadDetailPanel.tsx     Lead detail side panel
│       │       ├── ValidationPanel.tsx     Batch AI lead qualification
│       │       ├── ResearchPage.tsx        Research queue + full results viewer
│       │       ├── CompanyIntelligencePage.tsx  Evidence trail + per-source data viewer
│       │       ├── OutreachPanel.tsx       Conversation tracker per lead
│       │       ├── SettingsPanel.tsx       API keys, thresholds, Interakt config
│       │       ├── AnalyticsSection.tsx    Stats overview
│       │       ├── ActivityLogPanel.tsx    Event audit trail
│       │       ├── BackupRestoreSection.tsx MSSQL sync + JSON backup
│       │       ├── CsvImportSection.tsx    Bulk lead import
│       │       ├── Topbar.tsx              Header + theme toggle
│       │       └── Sidebar.tsx             Navigation
│       ├── services/
│       │   ├── sqlSyncService.ts       All MSSQL API calls
│       │   │                           (saveResearchToSql, saveDeepResearchToSql,
│       │   │                            syncToSql with leadIdMap write-back, restore)
│       │   ├── researchService.ts      Research job processor (evidence pipeline)
│       │   ├── googleEvidenceService.ts  Google search → classified, scored SearchEvidence
│       │   ├── linkClassifier.ts       URL → DetectedType + company name-match scoring
│       │   ├── sourcePageService.ts    Visits one source link + per-page AI extraction
│       │   ├── companyResearchAggregator.ts  Merges source pages → CompanyResearch
│       │   ├── deepResearchService.ts  Social intelligence orchestrator
│       │   ├── outreachService.ts      Conversation logging + stage updates
│       │   ├── interaktService.ts      Interakt WhatsApp Business API
│       │   ├── socialScraper.ts        LinkedIn / Twitter / Instagram tab scraper
│       │   ├── websiteFetcher.ts       Website + Google + directory crawling
│       │   ├── leadValidationService.ts  Batch AI lead qualification
│       │   ├── directoryDiscovery.ts   IndiaMART / JustDial / TradeIndia scraper
│       │   ├── openAiResearch.ts       OpenAI GPT research
│       │   ├── claudeResearch.ts       Anthropic Claude research
│       │   ├── geminiResearch.ts       Google Gemini research
│       │   ├── backupSyncService.ts    Local backup export/import
│       │   └── exportService.ts        CSV / JSON export
│       ├── db/
│       │   ├── db.ts                   Dexie schema (v7: searchSessions, leads,
│       │   │                            researchJobs, researchResults, deepResearch,
│       │   │                            searchEvidence, sourcePages, companyResearch,
│       │   │                            activityLogs, settings, ...)
│       │   ├── leadRepository.ts
│       │   ├── searchSessionRepository.ts
│       │   ├── researchJobRepository.ts
│       │   ├── researchResultRepository.ts
│       │   ├── searchEvidenceRepository.ts
│       │   ├── sourcePageRepository.ts
│       │   ├── companyResearchRepository.ts
│       │   └── activityLogRepository.ts
│       ├── state/
│       │   ├── useSettingsStore.ts     App config (persisted to IndexedDB)
│       │   ├── useLeadStore.ts         Lead list + selection + filters
│       │   ├── useSearchStore.ts       Session list
│       │   ├── useCaptureStore.ts      Active capture progress
│       │   └── useToastStore.ts        Toast notifications
│       └── types/
│           ├── lead.ts                 Lead + LeadStatus + LeadFilter
│           ├── research.ts             ResearchResult + ResearchJob
│           ├── deepResearch.ts         DeepResearch + PersonActivity + SocialPost
│           ├── settings.ts             AppSettings + DEFAULT_SETTINGS
│           ├── messages.ts             Chrome message types
│           ├── searchSession.ts        SearchSession
│           └── searchEvidence.ts       SearchEvidence + SourcePage + CompanyResearch
│
└── DeepLeadApi/                       ASP.NET 9 Minimal API
    ├── Program.cs                     All endpoints + DTOs (single file)
    ├── schema.sql                     MSSQL DDL — safe to re-run (base schema)
    ├── schema_v2_addons.sql           MSSQL DDL — nurture sequences / follow-ups
    ├── schema_v3_research_evidence.sql  MSSQL DDL — evidence-based research tables
    └── appsettings.example.json       Config template (copy → appsettings.json)
```

---

## Prerequisites

- **Node.js** 18+ and npm 9+
- **Google Chrome** (latest)
- **.NET 9 SDK**
- **SQL Server** (Express edition works — free download from Microsoft)
- API key from at least one of:
  - [Google AI Studio — Gemini](https://aistudio.google.com/apikey) ← recommended (best for Indian company research)
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/)
- *(Optional)* [Interakt](https://www.interakt.shop/) account with WhatsApp Business API access for automated WA outreach

---

## Setup

### 1. Create the Database

Open SQL Server Management Studio (SSMS), connect to your SQL Server instance, then run:

```sql
CREATE DATABASE deeplead;
```

Now open `DeepLeadApi/schema.sql` in SSMS and run it against the `deeplead` database, then run `schema_v2_addons.sql` and `schema_v3_research_evidence.sql` in order.
All three scripts are safe to re-run — every table and column uses `IF NOT EXISTS` guards.

### 2. Configure and Start the API

```bash
cd DeepLeadApi

# Copy config template
copy appsettings.example.json appsettings.json
```

Edit `appsettings.json` and fill in your SQL Server connection string:

```json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=YOUR_SERVER;Database=deeplead;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

Start the API:

```bash
dotnet run
```

Verify it's running:

```
GET http://localhost:5150/api/health
→ { "ok": true }
```

> **Important:** `appsettings.json` is gitignored and must never be committed. It contains your connection string.

### 3. Build and Load the Extension

```bash
cd leadscout-ai-extension
npm install
npm run build
```

Load in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `leadscout-ai-extension/dist/` folder
5. The LeadScout AI icon appears in your toolbar

### 4. Configure API Keys in the Extension

Click the extension icon → **Open Dashboard** → **Settings**

- Select your AI provider (Gemini recommended)
- Paste your API key
- Add your business profile (used for lead validation)
- *(Optional)* Add Interakt API key + template name for WhatsApp automation

---

## Usage

### Capturing Leads

1. Open the Dashboard → **Search Console**
2. Enter a city and keyword (e.g. City: `Indore`, Keyword: `Packaging`)
3. Click **Start Search** — the extension opens Google Maps automatically and starts scrolling
4. Watch the live progress badge and **Live Capture** panel
5. When done, go to **Lead Database** to see all captured leads

> Use **Search Presets** to save frequently used searches (e.g. "Indore — Packaging", "Pune — Pharma")

### Validating Leads

1. Go to **Selected Leads** → click **Validate with AI**
2. The AI reads your business profile and scores each lead as relevant or not
3. Irrelevant leads are filtered out automatically

### Running AI Research

1. In **Lead Database**, select leads → click **Add to Research Queue**
2. Go to **Research Queue**
3. Click **▶ Run Now**

Each lead gets a full company profile:
- Decision maker name + LinkedIn
- Email, WhatsApp, social profiles
- Team members with roles
- Revenue, founding year, certifications, major clients
- Pain points, expansion signals, current software

Research results are saved to MSSQL immediately on completion.

> Enable **Auto-Research** in Settings to queue all captured leads automatically.

### Deep Research — Social Intelligence

1. Open any completed research result → **Social Intel** tab
2. Click **Run Deep Research**

The extension will:
1. Find team member LinkedIn profiles from the company `/people/` page
2. Scroll through 6 months of each person's posts
3. Scrape company Twitter and Instagram
4. Run AI analysis to extract intent signals and generate a personalized pitch

> You must be **logged into LinkedIn and Twitter** in Chrome. The extension uses your existing session — no credentials are stored.

### Outreach

1. Open a researched lead → **Outreach** tab
2. Available channels are shown based on what research found (WhatsApp, LinkedIn, Email, Instagram, Facebook)
3. For WhatsApp (with Interakt configured): message is sent automatically via API
4. For other channels: platform opens in a new tab with the message pre-filled
5. Log replies and move the conversation through pipeline stages

Pipeline stages: **Cold → Contacted → Replied → Nurturing → Meeting Scheduled → Won / Lost**

### Export

In **Lead Database**:
- Select leads (or select all)
- Click **CSV** or **JSON** to export

---

## Settings Reference

| Setting | Purpose |
|---|---|
| **Auto-scroll Delay** | Milliseconds between scroll steps (default: 2000ms). Increase if Maps feels slow |
| **Max Scroll Attempts** | Hard cap on scroll iterations per search (default: 60) |
| **No-new-lead Stop** | Stop scrolling after this many consecutive scrolls find nothing new (default: 12) |
| **Default Max Results** | Lead capture limit per session (default: 100) |
| **Capture Phone / Website** | Toggle whether to extract phone and website from Maps cards |
| **Business Profile** | Describe your company and ideal customer — used by AI to validate leads |
| **AI Provider** | Gemini (recommended), OpenAI, or Anthropic |
| **AI API Key** | Your key for the selected provider — stored locally in IndexedDB only |
| **AI Model** | Select model within the chosen provider |
| **Auto-Research** | Automatically queue every captured lead for AI research |
| **Interakt API Key** | From your Interakt dashboard → Settings → Developer |
| **WhatsApp Template Name** | Name of your pre-approved WhatsApp template in Interakt |
| **Country Code** | Default phone country code for WhatsApp (default: +91) |
| **Theme** | Dark or light mode — toggled from the ☀/🌙 button in the top bar |
| **Debug Logs** | Show detailed output in the Activity Logs panel |

---

## API Reference

All endpoints run on `http://localhost:5150`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check → `{ ok: true }` |
| GET | `/api/config` | Get AI provider config |
| POST | `/api/leads/save-batch` | Batch upsert leads during capture |
| POST | `/api/leads/save` | Single lead save with validation status |
| POST | `/api/sync` | Full session sync, returns `leadIdMap` |
| POST | `/api/research/save` | Save AI research result (auto-called) |
| POST | `/api/deep-research/save` | Save deep research / social intel (auto-called) |
| POST | `/api/outreach/send` | Log outbound message, create conversation |
| POST | `/api/outreach/reply` | Log inbound reply |
| POST | `/api/outreach/stage` | Update conversation stage |
| GET | `/api/outreach/{companyId}` | Fetch conversation history |
| GET | `/api/restore` | Restore all leads + enrichments on reinstall |
| GET | `/api/restore/full/{companyId}` | Restore research + deep research for one company |
| POST | `/api/extension-backup` | Save IndexedDB JSON snapshot |
| GET | `/api/extension-backup` | Retrieve JSON snapshot |

---

## Database Tables

| Table | Purpose |
|---|---|
| `search_projects` | Search sessions (city + keyword + totals) |
| `companies` | All captured leads with validation + outreach status |
| `company_enrichments` | AI research results (30+ fields + JSON arrays) |
| `company_contacts` | Individual team members (one row per person) |
| `company_deep_research` | Social intel, intent signals, pitch template |
| `search_evidence` | Every classified Google search result per company (accepted + rejected, with reasons) |
| `source_pages` | Each source link actually opened, raw text + per-page AI extraction |
| `company_research` | Merged, confidence-weighted profile from all source pages (powers Company Intelligence page) |
| `outreach_conversations` | One thread per company + channel |
| `conversation_messages` | Full inbound/outbound message log |
| `nurture_templates` | Reusable message templates |
| `nurture_sequences` | Scheduled nurture sends per company + template |

View `vw_lead_pipeline` joins all tables for full pipeline reporting.

---

## How Social Scraping Works

The Deep Research feature uses Chrome's `scripting` API to inject JavaScript into hidden background tabs (never visible to the user). It reads page DOM using the existing logged-in browser session.

It does **NOT**:
- Bypass login or CAPTCHA
- Store credentials
- Send any personal data to external servers

It only reads **publicly visible business content** — the same information a logged-in user would see by manually browsing to the profile.

The 6-month scroll loop runs inside the tab context:
1. Scroll down, wait 2.5 seconds for content to load
2. Extract post text, date, and URL
3. Parse post dates — stop when oldest post is older than 6 months
4. Or stop if no new content after 3 consecutive scrolls (max 30 scrolls total)

---

## Security Notes

- All API keys are stored locally in **IndexedDB** inside the extension — never sent to our servers
- Keys are sent only directly to the respective AI provider (Anthropic, OpenAI, or Google)
- The Interakt API key is sent only to `api.interakt.ai` for WhatsApp delivery
- `appsettings.json` (which contains the SQL connection string) is gitignored — never commit it
- The local API only binds to `localhost:5150` — not exposed on the network

---

## Troubleshooting

**Capture shows 0 leads**
- Open Google Maps manually and confirm results are visible for your search
- Increase Auto-scroll Delay to 3000ms in Settings
- If Maps updated its DOM, update selectors in `src/content/mapsExtractor.ts`

**Research fails / no API key error**
- Verify API key is set in Settings → AI Research for the selected provider
- Check the browser console (F12) for error details
- Make sure the selected provider is not rate-limited

**Deep Research — "login required"**
- Log into LinkedIn (and Twitter/X) in Chrome, then retry
- Do not use incognito mode — the extension uses your normal Chrome session

**Data missing after extension reinstall**
- Make sure the API is running: `http://localhost:5150/api/health`
- Dashboard auto-restores from MSSQL on first load — wait a few seconds and reload

**WhatsApp not sending via Interakt**
- Verify Interakt API key in Settings → WhatsApp Outreach
- Make sure the template name matches exactly what is in your Interakt dashboard
- Check that the template is approved by Meta and the status is Active
- Verify the phone number has opted in (WhatsApp Business requirement)

**MSSQL schema error**
- Re-run `schema.sql`, `schema_v2_addons.sql`, and `schema_v3_research_evidence.sql` in order in SSMS — all are safe to run multiple times
- Make sure you are connected to the `deeplead` database (not master)

---

## License

MIT
