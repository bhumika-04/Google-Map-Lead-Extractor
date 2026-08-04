import React, { useEffect, useRef, useState } from 'react'
import { mapImportedRow } from '@/utils/csvImport'
import { parseSpreadsheet, isSpreadsheetFile, IMPORT_ACCEPT } from '@/utils/spreadsheet'
import { sessionRepository } from '@/db/sessionRepository'
import { importedLeadRepo } from '@/db/pipelineLeadRepository'
import {
  createSessionInSql, saveLeadBatchToSql,
} from '@/services/pipelineSyncService'
import { useSettingsStore } from '@/state/useSettingsStore'
import { toast } from '@/state/useToastStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import type { SessionRecord } from '@/types/session'
import type { ImportedLead, PipelineLeadStatus } from '@/types/pipelineLead'

// Per-screen import behaviour. The same panel is reused on Lead Database,
// Selected Leads, and Research Queue — only the target status changes, so
// imports always match the screen they land on. All imports write to the
// imported_leads store (never mixed with scraped/session leads).
export type ImportMode = 'leads' | 'selected' | 'research'

const MODE_META: Record<ImportMode, { title: string; blurb: string; cta: string; status: PipelineLeadStatus }> = {
  leads:    { title: 'Import CSV / Excel',              blurb: 'Add rows as new imported leads',                     cta: 'Import as new leads',   status: 'new' },
  selected: { title: 'Import CSV / Excel to Selected',  blurb: 'Bring in an outside list — lands as Selected',       cta: 'Import to Selected',    status: 'selected' },
  research: { title: 'Import CSV / Excel to Research',  blurb: 'Import a list and queue every row for research',     cta: 'Import & queue research', status: 'research_queued' },
}

export default function ImportPanel({ mode }: { mode: ImportMode }) {
  const { settings } = useSettingsStore()
  const fileRef = useRef<HTMLInputElement>(null)

  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [importing, setImporting] = useState(false)

  // Target import session: an existing one, or 'new' to create on import.
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [target, setTarget] = useState<number | 'new' | ''>('')
  const [newName, setNewName] = useState('')

  const meta = MODE_META[mode]

  async function refreshSessions() {
    const all = await sessionRepository.getBySource('import').catch(() => [])
    setSessions(all)
    setTarget((prev) => (prev === '' && all[0]?.id !== undefined ? all[0].id! : prev))
  }
  useEffect(() => { if (open) refreshSessions() }, [open])

  async function readFile(file: File) {
    if (!isSpreadsheetFile(file.name)) { toast.warning('Please choose a .csv, .xlsx or .xls file'); return }
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

  // Resolve (and if needed create) the target import session — returns its local id + mssqlId.
  async function resolveSession(): Promise<{ id: number; mssqlId?: number } | null> {
    if (target === 'new') {
      const name = newName.trim()
      if (!name) { toast.warning('Name the new session first'); return null }
      const rec: SessionRecord = {
        name, source: 'import',
        country: settings.lastCountry || 'IN',
        keywords: [], cities: [],
        businessProfile: settings.businessProfile ?? '',
        status: 'completed', totalLeads: 0,
        createdAt: new Date().toISOString(),
      }
      const id = await sessionRepository.create(rec)
      const mssqlId = await createSessionInSql({ ...rec, id }).catch(() => null)
      if (mssqlId) await sessionRepository.update(id, { mssqlId })
      return { id, mssqlId: mssqlId ?? undefined }
    }
    if (typeof target === 'number') {
      const s = await sessionRepository.getById(target)
      return s?.id ? { id: s.id, mssqlId: s.mssqlId } : null
    }
    toast.warning('Pick a session to import into (or create a new one)')
    return null
  }

  async function handleImport() {
    if (rows.length === 0) return
    const session = await resolveSession()
    if (!session) return

    setImporting(true)
    const leads: Array<Omit<ImportedLead, 'id'>> = []
    let skipped = 0
    for (const row of rows) {
      const lead = mapImportedRow(row, session.id, meta.status)
      if (!lead) { skipped++; continue }
      leads.push(lead)
    }

    // Local write (dedupe on session + normalizedName).
    const saved = await importedLeadRepo.upsertCapture(
      session.id,
      leads as Array<Partial<ImportedLead> & { normalizedName: string; companyName: string }>,
    )
    await sessionRepository.addLeads(session.id, saved)

    // Best-effort sync to the backend + backfill mssqlId.
    if (session.mssqlId) {
      try {
        const idMap = await saveLeadBatchToSql('imported', session.mssqlId, leads as ImportedLead[], fileName)
        const rowsNow = await importedLeadRepo.getBySession(session.id)
        for (const r of rowsNow) {
          const serverId = idMap[r.normalizedName]
          if (serverId && r.id && r.mssqlId !== serverId) await importedLeadRepo.update(r.id, { mssqlId: serverId })
        }
      } catch { /* offline — local stays source of truth */ }
    }

    setImporting(false)
    reset()
    await refreshSessions()
    const summary = `Imported ${saved} leads${skipped ? `, ${skipped} skipped (no company name)` : ''}`
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
            <label className="text-xs text-gray-500">Import session</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : e.target.value === '' ? '' : Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500 max-w-[220px]"
            >
              <option value="">Select a session…</option>
              {sessions.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
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
            <input ref={fileRef} type="file" accept={IMPORT_ACCEPT} className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f) }} />
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
              <button onClick={reset} className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">Clear</button>
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
            Imported leads go to the Lead Database (kept separate from scraped session leads). Duplicates within a session are updated in place.
          </div>
        </div>
      )}
    </div>
  )
}
