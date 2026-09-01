import React, { useRef, useState } from 'react'
import { parseSpreadsheet, isSpreadsheetFile, IMPORT_ACCEPT } from '@/utils/spreadsheet'
import { mapRow } from '@/utils/csvImport'
import { leadRepository } from '@/db/leadRepository'
import { isDuplicate, mergeLeadData } from '@/utils/dedupe'
import { addToResearchQueue } from '@/services/futureResearchService'
import { toast } from '@/state/useToastStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import { MSG } from '@/types/messages'
import type { Lead } from '@/types/lead'

// Per-session CSV/Excel import — lands rows directly in THIS session's Leads
// or Selected tab (legacy `leads` table, scoped by projectId), instead of the
// separate imported_leads universe ImportPanel/Lead Database use.
//
// Duplicate-safe against THIS session's own leads only — a same-named
// company captured under a different session/campaign is never touched.
export type SessionImportMode = 'leads' | 'selected'

const MODE_META: Record<SessionImportMode, { title: string; blurb: string }> = {
  leads:    { title: 'Import CSV/Excel to Leads',    blurb: 'Add rows as new leads in this session' },
  selected: { title: 'Import CSV/Excel to Selected', blurb: 'Bring in an outside list — lands here as selected, ready for research' },
}

export default function SessionCsvImport({ mode, projectId, onImported }: {
  mode: SessionImportMode
  projectId: number
  onImported?: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [queueResearch, setQueueResearch] = useState(mode === 'selected')
  const [importing, setImporting] = useState(false)

  const meta = MODE_META[mode]

  async function readFile(file: File) {
    if (!isSpreadsheetFile(file.name)) { toast.warning('Please choose a .csv, .xlsx or .xls file'); return }
    setFileName(file.name)
    try {
      const { rows: parsed } = await parseSpreadsheet(file)
      setRows(parsed)
      if (parsed.length === 0) toast.warning('No data rows found — the first row must be column headers (needs a company_name column)')
    } catch (err) {
      console.error('[session-import] parse failed', err)
      toast.error('Could not read that file — is it a valid CSV/Excel?')
    }
  }

  function reset() {
    setFileName(''); setRows([])
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleImport() {
    if (rows.length === 0) return
    setImporting(true)

    let created = 0, upgraded = 0, mergedCount = 0, skipped = 0, queued = 0
    const toQueue: Lead[] = []

    // Snapshot THIS session's existing leads once — every row is checked
    // against it, and newly-created/updated rows are appended so later rows
    // in the same file can dedupe against earlier ones too.
    const sessionLeads = await leadRepository.getByFilter({ projectId })

    for (const row of rows) {
      const mapped = mapRow(row, 0)
      if (!mapped) { skipped++; continue }
      mapped.projectId = projectId
      if (mode === 'selected') {
        mapped.status = 'selected'
        mapped.validationStatus = 'relevant'
        mapped.validationReason = 'Imported via CSV to Selected Leads'
      }

      const existing = isDuplicate(mapped, sessionLeads)

      try {
        if (existing?.id) {
          if (mode === 'selected') {
            // Upgrade in place — never downgrade a lead already further along.
            if (existing.status === 'new' || existing.status === 'rejected') {
              await leadRepository.updateStatus(existing.id, 'selected')
              await leadRepository.updateValidation(existing.id, 'relevant', 'Imported via CSV to Selected Leads')
              upgraded++
            } else {
              skipped++
            }
          } else {
            // Leads mode — fill in any fields the existing row is missing,
            // never create a second copy of the same company.
            const patch = mergeLeadData(existing, mapped)
            if (Object.keys(patch).length > 0) {
              await leadRepository.patchMissingFields(existing.id, patch)
              mergedCount++
            } else {
              skipped++
            }
          }
          const fresh = await leadRepository.getById(existing.id)
          if (fresh) {
            const idx = sessionLeads.findIndex((l) => l.id === fresh.id)
            if (idx >= 0) sessionLeads[idx] = fresh
            if (fresh.status === 'selected') toQueue.push(fresh)
          }
        } else {
          const id = await leadRepository.create(mapped)
          created++
          const fresh = await leadRepository.getById(id)
          if (fresh) {
            sessionLeads.push(fresh)
            if (fresh.status === 'selected') toQueue.push(fresh)
          }
        }
      } catch {
        skipped++
      }
    }

    if (mode === 'selected' && queueResearch) {
      for (const lead of toQueue) {
        try { await addToResearchQueue(lead); queued++ } catch { /* already queued */ }
      }
      if (queued > 0) chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
    }

    setImporting(false)
    reset()
    onImported?.()

    const summary = `${meta.title}: ${created} imported${upgraded ? `, ${upgraded} upgraded` : ''}${mergedCount ? `, ${mergedCount} merged` : ''}${skipped ? `, ${skipped} skipped (duplicate/no name)` : ''}${queueResearch && mode === 'selected' && queued ? ` — ${queued} queued for research` : ''}`
    toast.success(summary)
    activityLogRepository.log('csv_import_session', summary, projectId).catch(() => {})
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
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

          {rows.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              {mode === 'selected' && (
                <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={queueResearch}
                    onChange={(e) => setQueueResearch(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Queue all for deep research immediately
                </label>
              )}
              <span className="flex-1" />
              <button onClick={reset} className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">Clear</button>
              <button
                onClick={handleImport}
                disabled={importing}
                className="text-xs px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
              >
                {importing ? 'Importing…' : `Import ${rows.length} to ${mode === 'selected' ? 'Selected' : 'Leads'}`}
              </button>
            </div>
          )}

          <div className="text-[11px] text-gray-600">
            Duplicates are matched against this session's own leads only (by maps URL, phone, or name+city) — never a different session's data.
            {mode === 'leads' ? ' A match fills in any missing fields instead of creating a second copy.' : ' A match upgrades that lead to Selected instead of duplicating it.'}
          </div>
        </div>
      )}
    </div>
  )
}
