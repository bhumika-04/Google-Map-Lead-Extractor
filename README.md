# Google Map Lead Extractor

A full-stack B2B lead generation system built as a **Chrome Extension (MV3)** with a local **ASP.NET API** backend. It automates lead discovery from Google Maps, enriches each lead with AI-powered company research, and tracks social activity of key decision makers — all from a single dashboard.

---

## Features

### Lead Capture
- Search by **city + keyword** (e.g. "Packaging companies in Indore")
- Auto-scrolls Google Maps and captures all visible business listings
- Extracts: name, address, phone, website, rating, reviews, category, Google Maps URL
- Real-time deduplication — skips leads already in the database
- Live progress feed in the dashboard

### Lead Management
- **Lead Database** — sortable, filterable table of all captured leads
- Mark leads as **Selected** (interested) or **Rejected** (not relevant)
- **Selected Leads** view — filtered list ready for outreach
- Bulk actions: select all, bulk tag, bulk delete, export
- Export to **CSV** or **JSON**

### AI Research
- One-click research per lead — runs across multiple data sources:
  - Company website (full HTML parse)
  - Google Search (3 targeted queries)
  - IndiaMART direct listing
  - JustDial listing
  - Zaubacorp / AmbitionBox / directory pages
- Extracts: email, phone, social profiles, team members, revenue, year founded, certifications, major clients, pain points, expansion signals
- Supports **3 AI providers**: OpenAI (GPT-4o), Anthropic (Claude), Google Gemini
- Research results stored persistently with confidence score
- Auto-queues and processes leads in the background

### Deep Research — Social Intelligence
- Scrapes **LinkedIn, Twitter/X, Instagram** using your logged-in browser session (no API keys needed)
- Opens hidden background tabs — completely silent, user never sees them
- **Scrolls through 6 months of history** automatically — collects every post (trips, achievements, hiring, announcements, opinions)
- Company LinkedIn `/people/` page → resolves individual team member profiles directly (no guessing from name alone)
- Brand alias resolution: "Pragati Graphics and Packaging Pvt Ltd" → `pragatiglobal.com` → searches as "Pragati Global" to find correct profiles
- AI analyzes all collected activity → generates:
  - Intent signals ("Hiring ERP consultant → tech upgrade in progress")
  - Company signals ("Posted about new pharma client win")
  - Personalized pitch recommendation
  - Ready-to-send cold outreach template

### Data Persistence
- **MSSQL** is the single source of truth — survives extension reinstall
- On every dashboard load: pulls fresh data from MSSQL into local IndexedDB
- Real-time sync to MSSQL on every lead capture, tag, and research completion
- Local **IndexedDB** (Dexie.js) for fast UI reads

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                         │
│                                                                 │
│  ┌──────────────┐   ┌─────────────────┐   ┌────────────────┐  │
│  │ Dashboard UI  │   │ Service Worker  │   │ Content Script │  │
│  │ (React+Zustand│◄──│ (Background)    │──►│ (Maps DOM      │  │
│  │  Tailwind CSS)│   │ IndexedDB/Dexie │   │  Scraper)      │  │
│  └──────┬───────┘   └────────┬────────┘   └────────────────┘  │
│         │                    │                                  │
│  ┌──────▼───────────────────▼───────────────────────────────┐ │
│  │              Social Scraper (tab-based)                    │ │
│  │   Opens hidden tabs → LinkedIn / Twitter / Instagram       │ │
│  └───────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (localhost:5150)
                           ▼
┌─────────────────────────────────────┐
│  DeepLeadApi  (ASP.NET Minimal API) │
│  Dapper → MSSQL                     │
│                                     │
│  /api/sync          — batch upsert  │
│  /api/restore       — full restore  │
│  /api/leads/save    — per-lead save │
└─────────────────────────────────────┘
```

**Tech stack:**

| Layer | Tech |
|---|---|
| Extension UI | React 18, TypeScript, Tailwind CSS, Vite |
| State management | Zustand |
| Local DB | Dexie.js (IndexedDB wrapper) |
| Extension platform | Chrome MV3 (service worker + content scripts) |
| Backend API | ASP.NET 8 Minimal API |
| ORM | Dapper |
| Database | Microsoft SQL Server (Express) |
| AI providers | OpenAI GPT-4o, Anthropic Claude, Google Gemini |

---

## Project Structure

```
Google-Map-Lead-Extractor/
│
├── leadscout-ai-extension/          Chrome Extension
│   ├── public/
│   │   ├── manifest.json            MV3 manifest
│   │   └── icons/                   Extension icons
│   └── src/
│       ├── background/
│       │   └── serviceWorker.ts     Background worker — routing, DB, sync
│       ├── content/
│       │   ├── mapsContent.ts       Content script entry point
│       │   ├── mapsExtractor.ts     Google Maps DOM selectors
│       │   └── autoScroller.ts      Auto-scroll with stop conditions
│       ├── dashboard/
│       │   ├── Dashboard.tsx        Main dashboard shell + routing
│       │   └── components/
│       │       ├── SearchConsole.tsx      Start a new Maps search
│       │       ├── LeadTable.tsx          Lead Database view
│       │       ├── SelectedLeadsPage.tsx  Selected leads view
│       │       ├── ResearchPage.tsx       Research results + Social Intel tab
│       │       ├── SettingsPanel.tsx      AI keys, auto-scroll config
│       │       └── ValidationPanel.tsx    Bulk tag leads
│       ├── services/
│       │   ├── researchService.ts         Research job orchestration
│       │   ├── websiteFetcher.ts          Fetch website + Google Search
│       │   ├── openAiResearch.ts          OpenAI GPT research
│       │   ├── claudeResearch.ts          Anthropic Claude research
│       │   ├── geminiResearch.ts          Google Gemini research
│       │   ├── deepResearchService.ts     Social Intelligence orchestration
│       │   ├── socialScraper.ts           LinkedIn/Twitter/Instagram tab scraper
│       │   └── sqlSyncService.ts          MSSQL sync calls
│       ├── db/                       Dexie repositories
│       ├── state/                    Zustand stores
│       ├── types/                    TypeScript interfaces
│       └── utils/                    normalize, dedupe, date helpers
│
└── DeepLeadApi/                     ASP.NET Minimal API
    ├── Program.cs                   All endpoints + DB helpers
    └── appsettings.example.json     Config template (copy → appsettings.json)
```

---

## Prerequisites

- **Node.js** 18+ and npm 9+
- **Google Chrome** (latest)
- **.NET 8 SDK**
- **SQL Server** (Express edition is fine)
- An API key from at least one of:
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/)
  - [Google AI Studio (Gemini)](https://aistudio.google.com/apikey)

---

## Setup

### 1. Database

Create the database and tables in SQL Server:

```sql
CREATE DATABASE deeplead;
GO

USE deeplead;
GO

CREATE TABLE search_projects (
    id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    name            NVARCHAR(255) NOT NULL,
    city            NVARCHAR(100),
    keywords        NVARCHAR(255),
    status          NVARCHAR(50) DEFAULT 'active',
    total_found     INT DEFAULT 0,
    total_enriched  INT DEFAULT 0,
    created_at      DATETIME DEFAULT GETDATE(),
    updated_at      DATETIME DEFAULT GETDATE()
);

CREATE TABLE companies (
    id               UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    project_id       UNIQUEIDENTIFIER REFERENCES search_projects(id),
    place_id         NVARCHAR(200),
    name             NVARCHAR(500) NOT NULL,
    address          NVARCHAR(1000),
    phone            NVARCHAR(100),
    website          NVARCHAR(1000),
    google_maps_url  NVARCHAR(1000),
    rating           DECIMAL(3,1),
    review_count     INT,
    category         NVARCHAR(255),
    city             NVARCHAR(100),
    enrichment_status NVARCHAR(50) DEFAULT 'pending',
    validation_status NVARCHAR(50),
    created_at       DATETIME DEFAULT GETDATE(),
    updated_at       DATETIME DEFAULT GETDATE()
);

CREATE TABLE company_enrichments (
    id                 UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id         UNIQUEIDENTIFIER REFERENCES companies(id),
    official_website   NVARCHAR(1000),
    email              NVARCHAR(255),
    linkedin_url       NVARCHAR(1000),
    facebook_url       NVARCHAR(1000),
    instagram_url      NVARCHAR(1000),
    youtube_url        NVARCHAR(1000),
    owner_name         NVARCHAR(255),
    products_services  NVARCHAR(MAX),
    team_size          NVARCHAR(50),
    established_year   NVARCHAR(10),
    business_type      NVARCHAR(100),
    description        NVARCHAR(MAX),
    overall_confidence DECIMAL(5,4),
    lead_score         INT,
    enriched_at        DATETIME,
    updated_at         DATETIME DEFAULT GETDATE()
);

CREATE TABLE company_contacts (
    id             UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id     UNIQUEIDENTIFIER REFERENCES companies(id),
    full_name      NVARCHAR(255),
    email          NVARCHAR(255),
    linkedin_url   NVARCHAR(1000),
    source_type    NVARCHAR(50),
    confidence     DECIMAL(5,4),
    discovered_at  DATETIME DEFAULT GETDATE()
);
```

### 2. API Backend

```bash
cd DeepLeadApi

# Copy config template and fill in your values
cp appsettings.example.json appsettings.json
# Edit appsettings.json → set your SQL Server connection string and OpenAI key

# Run the API
dotnet run
# API starts at http://localhost:5150
```

Verify it's running:
```
GET http://localhost:5150/api/health
→ { "ok": true }
```

### 3. Chrome Extension

```bash
cd leadscout-ai-extension

# Install dependencies
npm install

# Build
npm run build
```

**Load in Chrome:**
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `leadscout-ai-extension/dist/` folder
5. The LeadScout AI icon appears in your toolbar

---

## Usage

### Capturing Leads

1. Click the LeadScout AI icon → **Open Dashboard**
2. Go to **Search Console**
3. Enter a city and keyword (e.g. City: `Indore`, Keyword: `Packaging`)
4. Click **Start Search** — extension opens Google Maps automatically
5. Watch live progress in the **Live Capture** panel
6. When done, go to **Lead Database** to see all captured leads

### Tagging Leads

In **Lead Database**:
- Click ✓ to mark a lead as **Selected** (interested)
- Click ✗ to mark as **Rejected**
- **Selected Leads** tab shows only your interested leads

### AI Research

1. Select leads in **Lead Database** → click **Add to Research Queue**
2. Go to **Research Results** tab
3. Click **Run Now** — runs in the background automatically
4. Each lead gets a full company profile: email, team members, revenue, social profiles, pain points

> Set your AI API key in **Settings** → AI Research. OpenAI is recommended (GPT-4o-mini works well).

### Deep Research / Social Intelligence

1. Open any completed research result
2. Click the **Social Intel** tab
3. Click **Run Deep Research**

The extension will:
- Open your company's LinkedIn `/people/` page → find team member profiles
- Scroll through 6 months of each person's LinkedIn posts
- Scroll through 6 months of company Twitter/X posts
- Scrape company Instagram posts
- Run AI analysis → generate intent signals and a personalized cold outreach pitch

> You must be **logged into LinkedIn and Twitter** in Chrome for this to work.

### Export

In **Lead Database** toolbar:
- Select leads (or select all)
- Click **CSV** or **JSON** to export

---

## Configuration

All settings are in the Dashboard → **Settings** panel.

| Setting | Description |
|---|---|
| AI Provider | OpenAI / Anthropic / Gemini |
| OpenAI API Key | Your OpenAI key (stored locally, never sent to our servers) |
| Anthropic API Key | Your Anthropic key |
| Gemini API Key | Your Google AI key |
| Auto-scroll Delay | Milliseconds between scroll steps (default: 2000ms) |
| Max Scroll Attempts | Hard cap on scroll iterations per search |
| No-new-lead Stop | Stop after N scrolls find nothing new (default: 5) |
| Default Max Results | Lead capture limit per session |
| Auto Research | Automatically research leads as they are captured |

---

## How Social Scraping Works

The Deep Research feature opens background tabs using Chrome's `scripting` API (no visible browser windows) and reads the page DOM using the user's existing logged-in session. It does NOT:
- Bypass login or captcha
- Store credentials
- Send any personal data to external servers

It only collects **publicly visible business content** — the same information a logged-in user would see by manually visiting the profile.

The scroll loop runs inside the tab context, loading posts batch by batch until it reaches posts older than 6 months or the feed ends (max 30 scroll attempts per person).

---

## Troubleshooting

**Capture shows 0 leads**
- Open Google Maps manually and check that results are visible
- Increase auto-scroll delay to 3000ms in Settings
- Google Maps may have updated its DOM — update selectors in `src/content/mapsExtractor.ts`

**Research fails**
- Verify the API is running: `http://localhost:5150/api/health`
- Check your AI API key is set in Settings
- Check the browser console for error details

**Social Intel tab — "login required"**
- Log into LinkedIn (and Twitter) in Chrome, then retry

**Extension not showing data after reinstall**
- Make sure the API is running — it restores data from MSSQL on first load

---

## License

MIT
