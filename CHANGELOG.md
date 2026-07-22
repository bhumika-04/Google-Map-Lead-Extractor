# Changelog

Notable changes to the LeadScout AI extension and DeepLead API.

## [Unreleased] — 2026-07-21

Data-loss fix, per-session pipeline, CSV/Excel import, a redesigned PDF export,
and reliability fixes across the research queue and tab handling.

> **Activate after pulling:** rebuild the extension (`cd leadscout-ai-extension && npm run build`)
> and reload it in Chrome (`chrome://extensions/` → ↻ on the LeadScout AI card).

---

### Fixed

- **Lead loss on dashboard reload (critical).** The MSSQL→IndexedDB sync ran a
  destructive "dedup" on every dashboard open that grouped **all** local leads by
  `normalizedName + city` across sessions and **deleted the extras**, silently
  turning a large multi-keyword capture (e.g. ~1,700 leads) into a fraction of
  that after a reload. The reload sync is now **purely additive** — it only
  UPSERTs/inserts and never deletes local leads. Because MSSQL retained the rows,
  reloading with this build also **restores** leads dropped by the old behaviour.
  (`background/serviceWorker.ts`)
- **Research Queue live indicator broken.** The "sources visited / current URL"
  panel read two IndexedDB stores that were removed in the v8 schema migration
  (`searchEvidence`, `sourcePages`), so it threw every 3s during a running job.
  Live progress is now published to `chrome.storage.local` by the research
  service and read by the dashboard; the two dead repositories are guarded so
  they can never throw. (`services/researchService.ts`, `dashboard/Dashboard.tsx`,
  `db/searchEvidenceRepository.ts`, `db/sourcePageRepository.ts`)
- **Scraper tabs accumulating into tab-access / "forbidden" errors.** On long
  multi-city/keyword research runs, MV3 kills the service worker mid-fetch, so the
  tab's `finally`-close never runs and the background tab is orphaned. Added a
  scraper-tab registry (in `chrome.storage.local`) plus `sweepOrphanScraperTabs()`,
  which runs on every research tick and on worker wake to close orphans. It only
  touches background tabs older than 3 minutes, so it can never close a tab that
  is in use, the Maps capture tab, or the LinkedIn RPA tab.
  (`services/socialScraper.ts`, `background/serviceWorker.ts`)
- **Incomplete addresses in exports.** Google Maps list cards expose only a
  fragment (e.g. "Shop 34"). Research now writes the fuller address it finds
  (registered office / directory / AI-mode answer) back to the lead, and the PDF
  export composes the fullest available address (street fragment + region).
  (`services/researchService.ts`, `services/exportService.ts`)

### Added

- **Named Search Sessions.** Search Console has a **Session name** field. Naming a
  run groups its leads, validation, and research under one workspace with its own
  ICP profile; blank auto-names as before. (`dashboard/components/SearchConsole.tsx`)
- **Session Pipeline page.** A new sidebar screen shows any session's funnel live —
  Captured → Enriched → Scored → Relevant → Researched — with stat tiles and
  actions (view leads/selected scoped to the session, queue relevant for research,
  run research now). (`dashboard/components/SessionDashboard.tsx`, `Sidebar.tsx`, `Dashboard.tsx`)
- **CSV / Excel import into a session.** A reusable import panel on **Lead
  Database**, **Selected Leads**, and **Research Queue** accepts `.csv`, `.xlsx`,
  and `.xls`, lets you pick or create a target Session, and applies the screen's
  operation (new leads · Selected · Selected + queued for research). Duplicate-safe.
  SheetJS is lazy-loaded so it doesn't bloat the dashboard bundle.
  (`dashboard/components/ImportPanel.tsx`, `utils/spreadsheet.ts`, `xlsx` dependency)

### Changed

- **PDF export redesigned** for a clean, aligned, professional multi-page dossier:
  fixed an invalid `shrink: 0` CSS bug (labels/ICP circle/avatars now hold their
  width), field rows are an aligned grid, each lead is a uniform page with a header
  eyebrow and a per-page footer, consistent `@page` A4 margins, and `break-inside:
  avoid` so content never splits awkwardly. Addresses render full-width and wrap
  instead of clipping. (`services/exportService.ts`)
