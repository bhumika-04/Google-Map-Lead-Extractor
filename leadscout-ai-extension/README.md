# LeadScout AI — Chrome Extension

Automated B2B lead discovery, AI research, and outreach from Google Maps. Search by market / city / keyword, capture and deduplicate listings, validate against your ICP, run evidence-based AI research, and track outreach — all from one dashboard, backed by a local MSSQL API.

---

## Setup

### Prerequisites
- Node.js 18+
- npm 9+
- Google Chrome (latest)

### Install & Build

```bash
# 1. Enter the project directory
cd leadscout-ai-extension

# 2. Install dependencies
npm install

# 3. Build the extension
npm run build
```

The built extension is output to the `dist/` folder.

For development (auto-rebuild on save):
```bash
npm run dev
```

---

## Load in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder inside `leadscout-ai-extension/`
5. The LeadScout AI extension icon appears in your toolbar

> If you rebuild (`npm run build`), click the **refresh icon** on the extension card in `chrome://extensions/`.

---

## Adding Icons

The manifest references `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.

Place PNG files at:
```
public/
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

They are automatically copied to `dist/icons/` during build.

---

## How to Search from Dashboard

1. Click the **LeadScout AI** extension icon → **Open Dashboard**
   - Or navigate directly to `chrome-extension://<ID>/dashboard/dashboard.html`
2. Click **Search Console** in the sidebar
3. Fill in:
   - **City**: e.g. `Indore`
   - **Keyword**: e.g. `Printing`, `CA Firms`, `Dentists`
   - **Max Results**: e.g. `100`
4. Click **Start Search**
5. The extension automatically opens Google Maps in a new tab
6. Watch the **Live Capture** progress in the dashboard
7. When complete, switch to **Lead Database** to review captured leads

---

## How to Review and Act on Leads

In **Lead Database**:

| Action | What it does |
|---|---|
| ✓ (green) | Mark lead as Interested / Selected |
| ✗ (red) | Mark lead as Not Relevant / Rejected |
| ⚗ (purple) | Add to Research Queue (evidence-based AI research) |
| ⌖ | Open in Google Maps |
| × | Delete lead |

**Bulk actions**: Check multiple rows → use bulk action buttons in toolbar.

---

## Import & Export Leads

**Import** — on **Lead Database**, **Selected Leads**, or **Research Queue**, drop a `.csv` / `.xlsx` / `.xls` file into the import panel and choose (or create) a **Session**. Imported rows are tagged to that session and follow the screen's pipeline (new leads · Selected · Selected + queued for research). Duplicate-safe.

**Export** — in the **Lead Database** toolbar:
- **CSV** / **JSON** — visible or selected leads
- **DOC** — Word document
- **PDF** — a professional one-lead-per-page research dossier (contact, enrichment, ICP score, key people, sources)

Select specific leads first to export only those rows.

---

## How Capture Works

```
Dashboard → Background → [Opens Maps Tab] → Content Script
    ↑                                              ↓
    ←←←← Progress Updates ←←←← Lead Data ←←←←←←←←
```

1. Dashboard sends `SEARCH_START` to Background service worker
2. Background opens `https://www.google.com/maps/search/{keyword}+in+{city}`
3. After Maps loads, Background sends `MAPS_START_CAPTURE` to the content script
4. Content script extracts visible business cards from Maps result panel
5. Auto-scroller slowly scrolls the panel to reveal more results
6. Each lead is sent to Background → deduplicated → stored in IndexedDB
7. Dashboard receives live progress updates via Chrome messaging

---

## Deduplication

Leads are deduplicated in this priority order:
1. Google Maps URL (most reliable)
2. Phone number
3. Normalized company name + normalized address
4. Normalized company name + city + keyword

When a duplicate is detected, missing fields are merged (e.g., if old record has no phone but new capture does, it's updated). The `duplicatesSkipped` counter increments.

---

## Project Structure

```
leadscout-ai-extension/
├── public/
│   ├── manifest.json          Chrome Extension manifest (MV3)
│   └── icons/                 Extension icons (add your own PNGs)
├── src/
│   ├── background/
│   │   └── serviceWorker.ts   Background service worker (routing, DB, dedup)
│   ├── content/
│   │   ├── mapsContent.ts     Content script entry (injected into Maps)
│   │   ├── mapsExtractor.ts   DOM extraction logic (easy to update selectors)
│   │   └── autoScroller.ts    Slow auto-scroll with stop conditions
│   ├── popup/                 Extension popup (quick status + open dashboard)
│   ├── dashboard/             Full dashboard UI (React + Tailwind)
│   │   └── components/        Sidebar, SearchConsole, LeadTable, etc.
│   ├── db/                    Dexie/IndexedDB repositories
│   ├── state/                 Zustand stores
│   ├── services/              chromeMessaging, export, mapsUrl, research
│   ├── types/                 TypeScript interfaces
│   └── utils/                 normalize, dedupe, date, logger
├── vite.config.ts
├── tailwind.config.js
└── package.json
```

---

## Settings

In the **Settings** section of the dashboard:

| Setting | Default | Description |
|---|---|---|
| Auto-scroll Delay | 2000ms | Pause between scrolls |
| Max Scroll Attempts | 60 | Hard limit on scroll iterations |
| No-new-lead Stop Threshold | 5 | Stop after N scrolls with no new leads |
| Default Max Results | 100 | Limit for new sessions |
| Capture Phone | ✓ | Extract phone from business cards |
| Capture Website | ✓ | Extract website from business cards |
| Enable Debug Logs | ✗ | Verbose console output |

---

## Updating Google Maps Selectors

If Maps DOM changes and capture stops working, update selectors in:

```
src/content/mapsExtractor.ts → const SELECTORS = { ... }
```

Each field has a prioritized array of CSS selectors — the extractor tries them in order. Add newer selectors at the top of each array.

---

## Permissions Used

| Permission | Why |
|---|---|
| `tabs` | Open Maps tab, track tab status |
| `storage` | Settings persistence |
| `scripting` | Inject content script if needed |
| `activeTab` | Communicate with active tab |
| Host: `*.google.com/maps/*` | Content script injection target |

---

## Feature Highlights

- [x] AI-powered company research (Gemini / OpenAI / Claude) — evidence-based, source-by-source
- [x] AI lead validation (ICP scoring) per Search Session
- [x] Decision maker & team discovery, social profiles, email finding
- [x] LinkedIn / social deep research → intent signals + pitch
- [x] Backend sync to MSSQL (single source of truth) + JSON backup
- [x] Named Search Sessions + a live per-session **Session Pipeline** page
- [x] CSV / Excel import into a session · CSV / JSON / DOC / PDF export
- [x] Outreach + nurture pipeline (WhatsApp via Interakt)

---

## Troubleshooting

**Capture shows 0 leads:**
- Open Maps manually and check if results are visible
- Increase the auto-scroll delay (Settings → 3000ms+)
- Google Maps DOM may have changed — update selectors in `mapsExtractor.ts`

**Extension icon shows no popup:**
- Reload the extension at `chrome://extensions/`

**Dashboard not opening:**
- Try: `chrome-extension://<YOUR_EXTENSION_ID>/dashboard/dashboard.html`

**Content script not responding:**
- Reload the Google Maps tab
- Check `chrome://extensions/` → LeadScout AI → Errors
