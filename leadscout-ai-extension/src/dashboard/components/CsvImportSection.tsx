import React, { useState, useRef } from 'react'
import { leadRepository } from '@/db/leadRepository'
import { normalizeLeadName } from '@/utils/dedupe'
import { nowISO } from '@/utils/date'
import { useLeadStore } from '@/state/useLeadStore'
import { useSearchStore } from '@/state/useSearchStore'
import { toast } from '@/state/useToastStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import type { Lead } from '@/types/lead'

// Maps common CSV column names → Lead field keys
// (exported for reuse by SelectedCsvImport — the Selected Leads quick importer)
export const FIELD_MAP: Record<string, keyof Lead> = {
  company_name: 'companyName', companyname: 'companyName', company: 'companyName', name: 'companyName', business: 'companyName',
  phone: 'phone', telephone: 'phone', mobile: 'phone', contact: 'phone',
  website: 'website', url: 'website', web: 'website',
  city: 'city', town: 'city', location: 'city',
  address: 'address', street: 'address',
  category: 'category', type: 'category', industry: 'category',
  rating: 'rating', stars: 'rating', score: 'rating',
  review_count: 'reviewCount', reviewcount: 'reviewCount', reviews: 'reviewCount', review_count2: 'reviewCount',
  notes: 'notes',
  tags: 'tags',
  keyword: 'keyword',
  google_maps_url: 'googleMapsUrl', googlemapsurl: 'googleMapsUrl', maps_url: 'googleMapsUrl',
}

export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [] }

  function parseLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim()); current = ''
      } else {
        current += ch
      }
    }
    result.push(current.trim())
    return result
  }

  const headers = parseLine(lines[0])
  const rows = lines.slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const vals = parseLine(line)
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h] = vals[i] ?? '' })
      return obj
    })

  return { headers, rows }
}

export function mapRow(row: Record<string, string>, sessionId: number): Omit<Lead, 'id'> | null {
  const mapped: Partial<Lead> = {}

  for (const [csvKey, val] of Object.entries(row)) {
    const normalized = csvKey.toLowerCase().replace(/[\s-]/g, '_')
    const field = FIELD_MAP[normalized] ?? FIELD_MAP[csvKey.toLowerCase().replace(/\s/g, '')]
    if (!field || !val) continue

    if (field === 'rating' || field === 'reviewCount') {
      const n = parseFloat(val)
      if (!isNaN(n)) (mapped as any)[field] = n
    } else if (field === 'tags') {
      mapped.tags = val.split(/[,;|]/).map((t) => t.trim()).filter(Boolean)
    } else {
      (mapped as any)[field] = val
    }
  }

  const companyName = (mapped.companyName ?? '').trim()
  if (!companyName) return null

  const now = nowISO()
  return {
    sessionId,
    companyName,
    normalizedName: normalizeLeadName(companyName),
    category:       mapped.category,
    rating:         mapped.rating,
    reviewCount:    mapped.reviewCount,
    address:        mapped.address,
    phone:          mapped.phone,
    website:        mapped.website,
    googleMapsUrl:  mapped.googleMapsUrl,
    searchQuery:    '',
    city:           (mapped.city ?? '').trim() || 'Imported',
    keyword:        (mapped.keyword ?? '').trim() || 'csv-import',
    source:         'google_maps',
    confidence:     0.8,
    status:         'new',
    notes:          mapped.notes,
    tags:           mapped.tags,
    capturedAt:     now,
    updatedAt:      now,
  }
}

export default function CsvImportSection() {
  const { loadLeads } = useLeadStore()
  const { sessions } = useSearchStore()
  const fileRef = useRef<HTMLInputElement>(null)

  const [headers, setHeaders]       = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([])
  const [allRows, setAllRows]       = useState<Record<string, string>[]>([])
  const [fileName, setFileName]     = useState('')
  const [sessionId, setSessionId]   = useState<number | ''>('')
  const [importing, setImporting]   = useState(false)
  const [result, setResult]         = useState<{ imported: number; skipped: number } | null>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setResult(null)

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const { headers: h, rows } = parseCSV(text)
      setHeaders(h)
      setAllRows(rows)
      setPreviewRows(rows.slice(0, 5))
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    if (!allRows.length) return
    if (sessionId === '') {
      toast.warning('Please select a session to import into')
      return
    }
    setImporting(true)
    let imported = 0; let skipped = 0

    for (const row of allRows) {
      const lead = mapRow(row, sessionId as number)
      if (!lead) { skipped++; continue }
      try {
        await leadRepository.create(lead)
        imported++
      } catch {
        skipped++
      }
    }

    await loadLeads()
    setImporting(false)
    setResult({ imported, skipped })
    toast.success(`Imported ${imported} leads${skipped > 0 ? ` (${skipped} skipped)` : ''}`)
    await activityLogRepository.log('export_completed', `CSV import: ${imported} leads added`)
    // Reset
    setHeaders([]); setAllRows([]); setPreviewRows([]); setFileName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file || !file.name.endsWith('.csv')) return
    setFileName(file.name); setResult(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const { headers: h, rows } = parseCSV(text)
      setHeaders(h); setAllRows(rows); setPreviewRows(rows.slice(0, 5))
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-5 max-w-4xl">

      {/* Header */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-white mb-1">Import CSV</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Import leads from a spreadsheet or another tool. The importer auto-detects common column names.
          Supported fields: <span className="text-gray-400">company_name, phone, website, city, address, category, rating, review_count, notes, keyword, tags, google_maps_url</span>
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="relative border-2 border-dashed border-gray-700 rounded-xl p-8 text-center
          hover:border-blue-600 transition-colors cursor-pointer group"
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={handleFile}
        />
        <div className="text-3xl mb-2 text-gray-700 group-hover:text-blue-500 transition-colors">↑</div>
        {fileName ? (
          <div>
            <div className="text-sm font-medium text-white">{fileName}</div>
            <div className="text-xs text-gray-500 mt-1">{allRows.length} rows detected</div>
          </div>
        ) : (
          <div>
            <div className="text-sm text-gray-400">Drop a CSV file here or click to browse</div>
            <div className="text-xs text-gray-600 mt-1">First row must be column headers</div>
          </div>
        )}
      </div>

      {/* Preview */}
      {previewRows.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Preview — first {previewRows.length} rows</span>
            <span className="text-xs text-gray-600">{allRows.length} total rows</span>
          </div>
          <div className="overflow-auto max-h-56">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-900 sticky top-0">
                <tr>
                  {headers.map((h) => {
                    const norm = h.toLowerCase().replace(/[\s-]/g, '_')
                    const mapped = FIELD_MAP[norm] ?? FIELD_MAP[h.toLowerCase().replace(/\s/g, '')]
                    return (
                      <th key={h} className="px-3 py-2 text-gray-500 font-medium border-b border-gray-800 whitespace-nowrap">
                        {h}
                        {mapped && <span className="ml-1 text-blue-700">→ {String(mapped)}</span>}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => (
                  <tr key={i} className="border-b border-gray-800/60 hover:bg-gray-800/30">
                    {headers.map((h) => (
                      <td key={h} className="px-3 py-1.5 text-gray-300 whitespace-nowrap truncate max-w-[140px]">
                        {row[h] || <span className="text-gray-700">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Session selector + import button */}
      {allRows.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 shrink-0">Import into session</label>
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value === '' ? '' : Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500"
            >
              <option value="">— select session —</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.keyword} — {s.city} ({s.totalCaptured})</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleImport}
            disabled={importing || sessionId === ''}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed
              text-white text-xs font-semibold rounded-lg transition-colors"
          >
            {importing ? 'Importing…' : `Import ${allRows.length} rows`}
          </button>

          <button
            onClick={() => { setHeaders([]); setAllRows([]); setPreviewRows([]); setFileName(''); if (fileRef.current) fileRef.current.value = '' }}
            className="text-xs px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="flex items-center gap-3 bg-green-950 border border-green-800 rounded-xl px-4 py-3">
          <span className="text-green-400 text-lg">✓</span>
          <div className="text-sm">
            <span className="text-green-300 font-semibold">{result.imported} leads imported</span>
            {result.skipped > 0 && <span className="text-gray-500 ml-2">{result.skipped} skipped (missing name)</span>}
          </div>
        </div>
      )}

      {/* Tips */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 space-y-1.5">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Tips</div>
        <Tip icon="•">Use <code className="text-gray-400">company_name</code> (or <code className="text-gray-400">name</code>, <code className="text-gray-400">company</code>) as the lead name — required</Tip>
        <Tip icon="•">Export from Google Sheets as CSV: File → Download → CSV</Tip>
        <Tip icon="•">The <code className="text-gray-400">tags</code> column supports comma-separated values: <code className="text-gray-400">hot,follow-up,Q4</code></Tip>
        <Tip icon="•">Imported leads are added with status <code className="text-gray-400">new</code> and confidence <code className="text-gray-400">80%</code></Tip>
        <Tip icon="•">Create a session first if you want to keep imported leads organised separately</Tip>
      </div>
    </div>
  )
}

function Tip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs text-gray-600">
      <span className="text-gray-700 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  )
}
