# Changelog

Notable changes to the LeadScout AI extension and DeepLead API.

## [Unreleased] — 2026-09-01

Cross-device sync, per-session ICP editing + per-step pipeline re-run,
per-session CSV/Excel import, a run of validation/enrichment correctness
fixes, backend crash fixes, and a large dead-code removal pass.

> **Activate after pulling:** rebuild the extension (`cd leadscout-ai-extension && npm run build`),
> reload it in Chrome, and restart the DeepLeadApi backend (`dotnet run`).

---

### Fixed

- **Validation prompt fed the AI two competing rulebooks.** `buildBatchPrompt`
  wrapped the configured business profile — which already defines its own
  reject rules, scoring dimensions, and relevance threshold — inside a
  second, hardcoded rule set appended after it. Symptoms: every rejected
  lead across every profile got the exact same boilerplate reason (the
  model was copying the prompt's own JSON example verbatim), and a custom
  threshold below 50 was silently overridden by a hardcoded
  `icpScore >= 50` check. Rewrote the prompt to treat the business profile
  as the sole authority. (`services/leadValidationService.ts`)
- **`leadId` from the AI response silently coerced to `0` when returned as a
  numeric string** instead of a bare number — every result in that batch
  got written to a nonexistent lead, so the funnel's Relevant count stayed
  frozen while the AI was scoring correctly. Now accepts both.
  (`services/leadValidationService.ts`)
- **Rejected leads never left `status: 'new'`.** Only relevant leads
  advanced to `selected`; a rejected lead's overarching status was never
  set to `rejected`, so the pipeline's own resume logic (scoped to
  `status === 'new'`) re-validated every previously-rejected lead again on
  every "Continue" click. (`services/autoPipelineService.ts`)
- **Funnel tiles (Enriched/Scored/Relevant) frozen for the whole run.** The
  legacy-to-new-schema mirror (`reconcileScrapedForLeads`) was only called
  once, after enrichment/validation/Verify-from-Google finished entirely —
  for a 3000+ lead session that's a funnel stuck at 0 for tens of minutes
  even though leads were visibly processing one by one. Now mirrors every
  ~20 leads during the run. (`services/autoPipelineService.ts`,
  `background/serviceWorker.ts`)
- **AI key resolution was local-first instead of backend-first.** Three
  independent places (`resolveAiCredentials`, `loadSettingsForResearch`,
  `cityService`'s `runAiText`) all preferred the extension's own Settings-page
  key and only checked `appsettings.json` if that was empty — so a stale key
  saved once in the extension UI would shadow a perfectly valid backend key
  forever. Flipped the priority everywhere: `appsettings.json` is checked
  first, unconditionally. (`services/sqlSyncService.ts`,
  `background/serviceWorker.ts`, `services/cityService.ts`)
- **Dashboard stuck on a stale API key if the backend was down at mount.**
  `useSettingsStore.load()` only ran once; if `dotnet run` wasn't up yet when
  the dashboard opened, it fell back to a stale/empty key and never retried,
  even after the backend came online. Now retries every 15s until reachable.
  (`state/useSettingsStore.ts`)
- **`save-batch` crashed under load.** The endpoint ran one `MERGE` per lead
  sequentially, holding row locks for the whole batch — a few hundred leads
  meant hundreds of round trips, occasionally exceeding SQL's command timeout
  under concurrent capture. Rewrote as one set-based `MERGE` via `OPENJSON`
  per batch (one round trip regardless of size), with a per-row fallback if
  the set-based path ever hits a duplicate-row conflict from pre-existing
  bad data. (`DeepLeadApi/Program.cs`)
- **`save-batch` crashed on companies whose name has no letters/digits.**
  `scraped_leads`/`imported_leads`' unique index excludes blank
  `normalized_name` from uniqueness, so several unrelated companies can
  legitimately share `normalized_name = ''` — the batch `MERGE`'s `ON`
  clause didn't account for that, so one blank-named row matched multiple
  existing rows at once and SQL rejected the whole batch. Excluded blank
  names from the match (mirroring the index's own filter).
  (`DeepLeadApi/Program.cs`)
- **AI-generated enrichment/research text crashed writes when too long for
  its column.** A model occasionally returns a full paragraph where a short
  field (e.g. `decision_maker`, `NVARCHAR(200)`) was expected — SQL Server
  rejects the whole `UPDATE` outright ("String or binary data would be
  truncated"), losing the entire write. Added a `Trunc()` helper applied to
  every narrow-column AI-sourced field across the enrichment, validation,
  and research endpoints. (`DeepLeadApi/Program.cs`)
- **Google Maps scraper rarely captured phone/website and truncated
  addresses.** List cards essentially never render phone/website inline —
  only the detail panel does. Capture now clicks into each new listing's
  detail panel to read the full phone/website/address before moving on
  (slower, but the fields are actually populated now).
  (`content/mapsContent.ts`, `content/mapsExtractor.ts`)
- **Session-imported leads collapsed same-named companies from different
  cities into one row.** The scraped_leads mirror write for CSV/Excel
  imports matched existing rows by company name alone; a national import
  with the same business name recurring across many cities (e.g. "Maruti
  Laminate" in both Ahmedabad and Surat) silently merged them, undercounting
  the workspace funnel against the actual lead table. Now matches by maps
  URL → phone → name+city, same as the legacy table's own dedup.
  (`dashboard/components/SessionCsvImport.tsx`)
- **Invisible toast text in both themes.** Light mode: `text-yellow-100` was
  overridden to a color that happened to exactly match the (unmodified)
  `bg-yellow-900` warning-toast background. Dark badge buttons (sky/indigo/
  violet "Re-run one step" row, plus a few others) used translucent
  dark-mode colors that read as near-invisible pale-on-white in light mode.
  (`styles/global.css`)
- **"Sync from Database" could destroy local data / restored data was
  incomplete.** Rebuilt as `restoreFromNewSchema()` — non-destructive
  upsert-by-`mssqlId` into Dexie, and rebuilds the legacy `searchProjects`+
  `leads` tables too (not just the new schema mirror) so Session Pipeline
  and the session switcher actually populate after a cross-device sync.
  (`services/restoreService.ts`, `dashboard/components/BackupRestoreSection.tsx`)
- **Pasting a comma-separated city list landed as one unsplit blob.** The
  city multi-select only split on comma/Enter via individual keystrokes;
  pasting "City A, City B, City C" arrives as one change event. Added an
  `onPaste` handler that splits on comma/newline/tab.
  (`dashboard/components/SearchConsole.tsx`)

### Added

- **Per-session ICP view/edit + per-step re-run.** Each session workspace now
  shows the *full* ICP prompt (not truncated) with inline edit/save synced to
  MSSQL, a one-click "Use global ICP" reset, and independent "Re-run one
  step" buttons for Enrichment / Validation / Research — instead of only a
  whole-pipeline Continue/Re-run-all. (`dashboard/components/SessionWorkspace.tsx`,
  `services/autoPipelineService.ts`)
- **Live per-lead validation feed.** A progress bar + running relevant count
  + one line per lead as it's scored (✓/✕, name, ICP reason), fed by a new
  `pipeline_state.recentResults` field updated during the run — not just a
  batch-level percentage. (`dashboard/components/PipelineControl.tsx`)
- **Per-session CSV/Excel import**, separate from the global Lead Database
  import — lands rows directly in a session's own Leads or Selected tab,
  duplicate-checked against that session's own leads only.
  (`dashboard/components/SessionCsvImport.tsx`)
- **Imported-lead qualification.** CSV/Excel imports previously had no
  validation/scoring step at all. Added `importedQualifyService.ts` +
  a "Qualify leads" button, reusing the existing pipeline status/keepalive/
  stop UI.
- **In-page centered confirmation dialog**, replacing `window.confirm()`
  everywhere (11 call sites) — themed, matches light/dark mode, Escape/Enter
  shortcuts. (`state/useConfirmStore.ts`, `dashboard/components/ConfirmDialog.tsx`)
- **`clean_database.sql`** — wipes all table data and reseeds identities
  back to 0 without touching schema, separate from the existing
  drop-and-rebuild script.

### Removed

- **~1,300 lines of dead MSSQL sync code** that silently called backend
  endpoints removed by the schema redesign (`/api/search-runs/*`,
  `/api/sync`, `/api/leads/save`, `/api/leads/save-batch` and
  `/api/leads/validate-bulk` without `{kind}`, `/api/companies/batch-icp`,
  `/api/research/save`, `/api/deep-research/save`, `/api/leads/meta`,
  `/api/phase3/*`, all `/api/linkedin/*` routes). Every call was wrapped in
  try/catch, so none of it ever crashed — it just did nothing on every
  call, including a ~330-line function that ran on **every dashboard open
  and every fresh install** for zero effect. `apiResearchService.ts`
  deleted outright (every export was dead). Session rename/ICP-edit sync
  was fixed rather than deleted — switched to the real
  `/api/sessions/{id}` route instead of a dead `/api/search-runs/{id}` one.

---

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
