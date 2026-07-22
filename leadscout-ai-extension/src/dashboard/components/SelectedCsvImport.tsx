import React, { useRef, useState } from 'react'
import { parseCSV, mapRow } from '@/utils/csvImport'
import { leadRepository } from '@/db/leadRepository'
import { isDuplicate } from '@/utils/dedupe'
import { addToResearchQueue } from '@/services/futureResearchService'
import { useLeadStore } from '@/state/useLeadStore'
import { toast } from '@/state/useToastStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import { MSG } from '@/types/messages'
import type { Lead } from '@/types/lead'

// Quick CSV import directly into Selected Leads — for lead lists that come
// from outside Google Maps (bought lists, exhibition contacts, another tool)
// and should skip capture + validation and go straight to deep research.
//
// Duplicate-safe: a row matching an existing lead (name+city / phone / maps
// URL) upgrades that lead to 'selected' instead of creating a second copy.

export default function SelectedCsvImport() {
  const { loadLeads, projectScope } = useLeadStore()
  const fileRef = useRef<HTMLInputElement>(null)

  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [queueResearch, setQueueResearch] = useState(true)
  const [importing, setImporting] = useState(false)

  function readFile(file: File) {
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const { rows: parsed } = parseCSV((ev.target?.result as string) ?? '')
      setRows(parsed)
      if (parsed.length === 0) toast.warning('No data rows found — first row must be column headers')
    }
    reader.readAsText(file)
  }

  function reset() {
    setFileName(''); setRows([])
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleImport() {
    if (rows.length === 0) return
    setImporting(true)

    let created = 0, upgraded = 0, skipped = 0, queued = 0
    const toQueue: Lead[] = []

    for (const row of rows) {
      const mapped = mapRow(row, 0)
      if (!mapped) { skipped++; continue }

      // Straight into the selected stage — imported lists are pre-qualified
      mapped.status = 'selected'
      mapped.validationStatus = 'relevant'
      mapped.validationReason = 'Imported via CSV to Selected Leads'
      if (projectScope && projectScope.id >= 0) mapped.projectId = projectScope.id

      try {
        const candidates = await leadRepository.findCandidatesForDedupe(
          0, mapped.normalizedName, mapped.phone, mapped.googleMapsUrl,
        )
        const existing = isDuplicate(mapped, candidates)

        if (existing?.id) {
          // Upgrade instead of duplicating — but never downgrade a lead that
          // is already selected or further along the research pipeline.
          if (existing.status === 'new' || existing.status === 'rejected') {
            await leadRepository.updateStatus(existing.id, 'selected')
            await leadRepository.updateValidation(existing.id, 'relevant', 'Imported via CSV to Selected Leads')
            upgraded++
          } else {
            skipped++
          }
          const fresh = await leadRepository.getById(existing.id)
          if (fresh && fresh.status === 'selected') toQueue.push(fresh)
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

    if (queueResearch) {
      for (const lead of toQueue) {
        try { await addToResearchQueue(lead); queued++ } catch { /* already queued */ }
      }
      if (queued > 0) chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
    }

    await loadLeads()
    setImporting(false)
    reset()

    const summary = `CSV → Selected: ${created} imported, ${upgraded} upgraded${skipped > 0 ? `, ${skipped} skipped` : ''}${queueResearch ? ` — ${queued} queued for deep research` : ''}`
    toast.success(summary)
    activityLogRepository.log('csv_import_selected', summary).catch(() => {})
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-800/40 transition-colors"
      >
        <span className="text-sm font-semibold text-white">⬆ Import CSV to Selected</span>
        <span className="text-xs text-gray-600 flex-1">
          Bring in an outside lead list — lands here as selected, ready for deep research
        </span>
        <span className="text-gray-600 text-xs shrink-0">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* Drop zone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const file = e.dataTransfer.files[0]
              if (file && file.name.endsWith('.csv')) readFile(file)
            }}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-gray-700 rounded-xl px-4 py-5 text-center hover:border-blue-600 transition-colors cursor-pointer group"
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f) }}
            />
            {fileName ? (
              <div className="text-sm text-white font-medium">
                {fileName} <span className="text-xs text-gray-500 font-normal">— {rows.length} rows</span>
              </div>
            ) : (
              <div className="text-xs text-gray-500 group-hover:text-gray-400">
                Drop a CSV here or click to browse — needs a <span className="text-gray-400">company_name</span> column;{' '}
                <span className="text-gray-400">city, phone, website, category</span> improve research quality
              </div>
            )}
          </div>

          {/* Options + import */}
          {rows.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={queueResearch}
                  onChange={(e) => setQueueResearch(e.target.checked)}
                  className="accent-blue-600"
                />
                Queue all for deep research immediately
              </label>

              {projectScope && projectScope.id >= 0 && (
                <span className="text-xs px-2 py-0.5 bg-purple-950/60 border border-purple-800 text-purple-300 rounded-full">
                  → session: {projectScope.name}
                </span>
              )}

              <span className="flex-1" />

              <button
                onClick={reset}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors"
              >
                Clear
              </button>
              <button
                onClick={handleImport}
                disabled={importing}
                className="text-xs px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
              >
                {importing ? 'Importing…' : `Import ${rows.length} leads to Selected`}
              </button>
            </div>
          )}

          <div className="text-[11px] text-gray-600">
            Duplicates of existing leads are upgraded to Selected, never duplicated. Research starts automatically within a minute when queued.
          </div>
        </div>
      )}
    </div>
  )
}
