import React, { useEffect, useRef, useState } from 'react'
import { mapRow } from '@/utils/csvImport'
import { parseSpreadsheet, isSpreadsheetFile, IMPORT_ACCEPT } from '@/utils/spreadsheet'
import { leadRepository } from '@/db/leadRepository'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { isDuplicate } from '@/utils/dedupe'
import { addToResearchQueue } from '@/services/futureResearchService'
import { syncDerivedLeads } from '@/services/derivedLeadsService'
import { useLeadStore } from '@/state/useLeadStore'
import { useSettingsStore } from '@/state/useSettingsStore'
import { toast } from '@/state/useToastStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import { MSG } from '@/types/messages'
import type { SearchProject } from '@/types/searchProject'
import type { Lead } from '@/types/lead'

// Per-screen import behaviour. The same panel is reused on Lead Database,
// Selected Leads, and Research Queue — only the target status (and whether we
// queue research) changes, so imports always match the screen they land on.
export type ImportMode = 'leads' | 'selected' | 'research'

const MODE_META: Record<ImportMode, { title: string; blurb: string; cta: string }> = {
  leads: {
    title: 'Import CSV / Excel',
    blurb: 'Add rows as new leads in a session — they flow through the normal pipeline',
    cta: 'Import as new leads',
  },
  selected: {
    title: 'Import CSV / Excel to Selected',
    blurb: 'Bring in an outside list — lands as Selected, ready for research',
    cta: 'Import to Selected',
  },
  research: {
    title: 'Import CSV / Excel to Research',
    blurb: 'Import a list and queue every row for deep research immediately',
    cta: 'Import & queue research',
  },
}

interface ImportPanelProps {
  mode: ImportMode
}

export default function ImportPanel({ mode }: ImportPanelProps) {
  const { loadLeads } = useLeadStore()
  const { settings } = useSettingsStore()
  const fileRef = useRef<HTMLInputElement>(null)

  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [importing, setImporting] = useState(false)

  // Target session: an existing project id, or 'new' to create one on import.
  const [projects, setProjects] = useState<SearchProject[]>([])
  const [target, setTarget] = useState<number | 'new' | ''>('')
  const [newName, setNewName] = useState('')

  const meta = MODE_META[mode]

  async function refreshProjects() {
    const all = await searchProjectRepository.getAll().catch(() => [])
    setProjects(all)
    // Default the selector to the most recent session if none picked yet.
    setTarget((prev) => (prev === '' && all[0]?.id !== undefined ? all[0].id! : prev))
  }
  useEffect(() => { if (open) refreshProjects() }, [open])

  async function readFile(file: File) {
    if (!isSpreadsheetFile(file.name)) {
      toast.warning('Please choose a .csv, .xlsx or .xls file')
      return
    }
    setFileName(file.name)
    try {
      const { rows: parsed } = await parseSpreadsheet(file)
      setRows(parsed)
      if (parsed.length === 0) toast.warning('No data rows found — the first row must be column headers (needs a company_name column)')
    } catch (err) {
      console.error('[import] parse failed', err)
      toast.error('Could not read that file — is it a valid CSV/Excel?')
    }
  }

  function reset() {
    setFileName(''); setRows([])
    if (fileRef.current) fileRef.current.value = ''
  }

  async function resolveProjectId(): Promise<number | null> {
    if (target === 'new') {
      const name = newName.trim()
      if (!name) { toast.warning('Name the new session first'); return null }
      const id = await searchProjectRepository.create({
        name,
        country: settings.lastCountry || 'IN',
        keywords: [],
        cities: [],
        businessProfile: settings.businessProfile ?? '',
        status: 'completed',           // an imported list is not a live capture run
        totalTerms: 0,
        completedTerms: 0,
        totalLeads: 0,
        source: 'search_console',
      })
      return id
    }
    if (typeof target === 'number') return target
    toast.warning('Pick a session to import into (or create a new one)')
    return null
  }

  async function handleImport() {
    if (rows.length === 0) return
    const projectId = await resolveProjectId()
    if (projectId === null) return

    setImporting(true)
    let created = 0, upgraded = 0, skipped = 0, queued = 0
    const toQueue: Lead[] = []

    for (const row of rows) {
      const mapped = mapRow(row, 0)
      if (!mapped) { skipped++; continue }

      mapped.projectId = projectId
      if (mode === 'selected' || mode === 'research') {
        mapped.status = 'selected'
        mapped.validationStatus = 'relevant'
        mapped.validationReason = 'Imported via file'
      } else {
        mapped.status = 'new'
      }

      try {
        const candidates = await leadRepository.findCandidatesForDedupe(
          0, mapped.normalizedName, mapped.phone, mapped.googleMapsUrl,
        )
        const existing = isDuplicate(mapped, candidates)

        if (existing?.id) {
          // Never downgrade a lead already further along; assign it to this
          // session if it had none, and upgrade to Selected when appropriate.
          const patch: Partial<Lead> = {}
          if (existing.projectId === undefined) patch.projectId = projectId
          if ((mode === 'selected' || mode === 'research') && (existing.status === 'new' || existing.status === 'rejected')) {
            patch.status = 'selected'
            patch.validationStatus = 'relevant'
            patch.validationReason = 'Imported via file'
            upgraded++
          } else {
            skipped++
          }
          if (Object.keys(patch).length) await leadRepository.updateMany([existing.id], patch)
          const fresh = await leadRepository.getById(existing.id)
          if (fresh && (fresh.status === 'selected' || fresh.status.startsWith('research'))) toQueue.push(fresh)
        } else {
          const id = await leadRepository.create(mapped)
          created++
          const fresh = await leadRepository.getById(id)
          if (fresh) toQueue.push(fresh)
        }
      } catch {
        skipped++
      }
    }

    // Keep the session's lead count roughly in step.
    if (created > 0) {
      const p = projects.find((x) => x.id === projectId)
      searchProjectRepository.update(projectId, { totalLeads: (p?.totalLeads ?? 0) + created }).catch(() => {})
    }

    if (mode === 'research') {
      for (const lead of toQueue) {
        try { await addToResearchQueue(lead); queued++ } catch { /* already queued */ }
      }
      if (queued > 0) chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
    }

    await loadLeads()
    await refreshProjects()
    await syncDerivedLeads()   // reflect imported selected/research leads in the dedicated tables
    setImporting(false)
    reset()

    const summary = `Import: ${created} added${upgraded ? `, ${upgraded} upgraded` : ''}${skipped ? `, ${skipped} skipped` : ''}${mode === 'research' && queued ? ` — ${queued} queued for research` : ''}`
    toast.success(summary)
    activityLogRepository.log('csv_import', `${meta.title} — ${summary}`).catch(() => {})
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-800/40 transition-colors"
      >
        <span className="text-sm font-semibold text-white">⬆ {meta.title}</span>
        <span className="text-xs text-gray-600 flex-1">{meta.blurb}</span>
        <span className="text-gray-600 text-xs shrink-0">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* Target session picker */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-500">Session</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : e.target.value === '' ? '' : Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500 max-w-[220px]"
            >
              <option value="">Select a session…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value="new">➕ New session…</option>
            </select>
            {target === 'new' && (
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New session name"
                className="bg-gray-800 border border-gray-700 text-white text-xs px-2.5 py-1.5 rounded-lg placeholder-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[160px]"
              />
            )}
          </div>

          {/* Drop zone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f) }}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-gray-700 rounded-xl px-4 py-5 text-center hover:border-blue-600 transition-colors cursor-pointer group"
          >
            <input
              ref={fileRef}
              type="file"
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f) }}
            />
            {fileName ? (
              <div className="text-sm text-white font-medium">
                {fileName} <span className="text-xs text-gray-500 font-normal">— {rows.length} rows</span>
              </div>
            ) : (
              <div className="text-xs text-gray-500 group-hover:text-gray-400">
                Drop a <span className="text-gray-400">CSV or Excel</span> file, or click to browse — needs a{' '}
                <span className="text-gray-400">company_name</span> column;{' '}
                <span className="text-gray-400">city, phone, website, category</span> improve results
              </div>
            )}
          </div>

          {/* Import actions */}
          {rows.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex-1" />
              <button onClick={reset} className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">
                Clear
              </button>
              <button
                onClick={handleImport}
                disabled={importing}
                className="text-xs px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
              >
                {importing ? 'Importing…' : `${meta.cta} (${rows.length})`}
              </button>
            </div>
          )}

          <div className="text-[11px] text-gray-600">
            Duplicates of existing leads are updated in place, never duplicated. Imported rows are tagged to the chosen session and appear in its pipeline.
          </div>
        </div>
      )}
    </div>
  )
}
