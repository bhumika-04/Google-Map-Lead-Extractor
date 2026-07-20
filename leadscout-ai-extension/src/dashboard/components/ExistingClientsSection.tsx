import React, { useEffect, useRef, useState } from 'react'
import { existingClientRepository } from '@/db/existingClientRepository'
import { normalizeLeadName } from '@/utils/dedupe'
import { normalizePhone } from '@/utils/normalize'
import { nowISO } from '@/utils/date'
import { toast } from '@/state/useToastStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import {
  uploadExistingClientsBatch,
  fetchExistingClients,
  deleteExistingClient,
} from '@/services/sqlSyncService'
import { exportRowsToCSV, type ExportRowInput } from '@/utils/csvExport'
import type { ExistingClient } from '@/types/existingClient'

// Maps common CSV column names → ExistingClient field keys
const FIELD_MAP: Record<string, 'companyName' | 'city' | 'phone' | 'contactName' | 'email' | 'notes'> = {
  company_name: 'companyName', companyname: 'companyName', company: 'companyName', name: 'companyName', business: 'companyName', client: 'companyName',
  phone: 'phone', telephone: 'phone', mobile: 'phone', contact_number: 'phone', contactnumber: 'phone', whatsapp: 'phone',
  city: 'city', town: 'city', location: 'city',
  contact_name: 'contactName', contactname: 'contactName', owner: 'contactName', person: 'contactName',
  email: 'email',
  notes: 'notes', remarks: 'notes',
}

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
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

function mapRow(row: Record<string, string>): Omit<ExistingClient, 'id'> | null {
  const mapped: Partial<Record<'companyName' | 'city' | 'phone' | 'contactName' | 'email' | 'notes', string>> = {}

  for (const [csvKey, val] of Object.entries(row)) {
    const normalized = csvKey.toLowerCase().replace(/[\s-]/g, '_')
    const field = FIELD_MAP[normalized] ?? FIELD_MAP[csvKey.toLowerCase().replace(/\s/g, '')]
    if (!field || !val) continue
    mapped[field] = val
  }

  const companyName = (mapped.companyName ?? '').trim()
  const phone = (mapped.phone ?? '').trim()
  // Need at least a company name or phone to be matchable at all
  if (!companyName && !phone) return null

  const now = nowISO()
  return {
    companyName: companyName || phone,
    normalizedName: normalizeLeadName(companyName || phone),
    city: mapped.city?.trim() || undefined,
    phone: phone || undefined,
    normalizedPhone: phone ? normalizePhone(phone) : undefined,
    contactName: mapped.contactName?.trim() || undefined,
    email: mapped.email?.trim() || undefined,
    notes: mapped.notes?.trim() || undefined,
    uploadedAt: now,
  }
}

export default function ExistingClientsSection() {
  const fileRef = useRef<HTMLInputElement>(null)

  const [headers, setHeaders] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([])
  const [allRows, setAllRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null)
  const [clients, setClients] = useState<ExistingClient[]>([])
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    const local = await existingClientRepository.getAll()
    setClients(local)
    setLoading(false)
  }

  // MSSQL is the source of truth — pull down on first open of this page.
  useEffect(() => {
    refresh()
    fetchExistingClients().then(async (remote) => {
      if (remote.length === 0) return
      await existingClientRepository.replaceAll(
        remote.map((r) => ({
          mssqlId: r.mssqlId,
          companyName: r.companyName,
          normalizedName: r.normalizedName,
          city: r.city,
          phone: r.phone,
          normalizedPhone: r.normalizedPhone,
          contactName: r.contactName,
          email: r.email,
          notes: r.notes,
          uploadedAt: r.uploadedAt,
        }))
      )
      await refresh()
    })
  }, [])

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setResult(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const { headers: h, rows } = parseCSV(text)
      setHeaders(h); setAllRows(rows); setPreviewRows(rows.slice(0, 5))
    }
    reader.readAsText(file)
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

  async function handleImport() {
    if (!allRows.length) return
    setImporting(true)
    let imported = 0; let skipped = 0
    const mapped: Omit<ExistingClient, 'id'>[] = []

    for (const row of allRows) {
      const client = mapRow(row)
      if (!client) { skipped++; continue }
      mapped.push(client)
      imported++
    }

    if (mapped.length) {
      await existingClientRepository.bulkCreate(mapped)
      const upload = await uploadExistingClientsBatch(
        mapped.map((c) => ({
          companyName: c.companyName, city: c.city, phone: c.phone,
          contactName: c.contactName, email: c.email, notes: c.notes,
        }))
      )
      if (!upload.ok) toast.warning('Saved locally, but DeepLeadApi is offline — not synced to MSSQL yet')
    }

    await refresh()
    setImporting(false)
    setResult({ imported, skipped })
    toast.success(`Added ${imported} existing client${imported === 1 ? '' : 's'}${skipped > 0 ? ` (${skipped} skipped)` : ''}`)
    await activityLogRepository.log('export_completed', `Existing clients import: ${imported} added`)
    setHeaders([]); setAllRows([]); setPreviewRows([]); setFileName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleExportCSV() {
    const rows: ExportRowInput[] = clients.map((c) => ({
      name: c.contactName || c.companyName,
      phone: c.phone,
      email: c.email,
      tags: c.city,
      creationDate: c.uploadedAt,
      companyName: c.companyName,
      address: undefined,
    }))
    exportRowsToCSV(rows, `existing-clients-export-${Date.now()}.csv`)
  }

  async function handleDelete(client: ExistingClient) {
    if (!confirm(`Remove ${client.companyName} from the existing-clients list? Outreach to them will no longer be blocked.`)) return
    if (client.mssqlId) await deleteExistingClient(client.mssqlId)
    if (client.id) await existingClientRepository.delete(client.id)
    await refresh()
    toast.success('Removed')
  }

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-white mb-1">Existing Clients</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Upload people or companies you're already in touch with — existing clients, ongoing leads, etc.
          Outreach is <span className="text-red-400 font-medium">hard-blocked</span> for any contact that matches by phone or company name + city, so you never message them twice.
          Supported columns: <span className="text-gray-400">company_name, phone, city, contact_name, email, notes</span>
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="relative border-2 border-dashed border-gray-700 rounded-xl p-8 text-center
          hover:border-red-600 transition-colors cursor-pointer group"
        onClick={() => fileRef.current?.click()}
      >
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
        <div className="text-3xl mb-2 text-gray-700 group-hover:text-red-500 transition-colors">⊘</div>
        {fileName ? (
          <div>
            <div className="text-sm font-medium text-white">{fileName}</div>
            <div className="text-xs text-gray-500 mt-1">{allRows.length} rows detected</div>
          </div>
        ) : (
          <div>
            <div className="text-sm text-gray-400">Drop a CSV file here or click to browse</div>
            <div className="text-xs text-gray-600 mt-1">First row must be column headers — needs company_name and/or phone</div>
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
                        {mapped && <span className="ml-1 text-red-700">→ {mapped}</span>}
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

      {/* Import button */}
      {allRows.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleImport}
            disabled={importing}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed
              text-white text-xs font-semibold rounded-lg transition-colors"
          >
            {importing ? 'Importing…' : `Add ${allRows.length} contacts to block list`}
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
            <span className="text-green-300 font-semibold">{result.imported} contacts added</span>
            {result.skipped > 0 && <span className="text-gray-500 ml-2">{result.skipped} skipped (no name or phone)</span>}
          </div>
        </div>
      )}

      {/* Current list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-white">Blocked contacts</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-600">{clients.length} total</span>
            {clients.length > 0 && (
              <button
                onClick={handleExportCSV}
                className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700"
              >
                ⤓ CSV
              </button>
            )}
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-gray-600">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-3xl mb-2 opacity-30">⊘</div>
            <div className="text-sm text-gray-500">No existing clients uploaded yet</div>
          </div>
        ) : (
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-900 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-gray-500 font-medium border-b border-gray-800">Company</th>
                  <th className="px-3 py-2 text-gray-500 font-medium border-b border-gray-800">Phone</th>
                  <th className="px-3 py-2 text-gray-500 font-medium border-b border-gray-800">City</th>
                  <th className="px-3 py-2 text-gray-500 font-medium border-b border-gray-800">Contact</th>
                  <th className="px-3 py-2 text-gray-500 font-medium border-b border-gray-800"></th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b border-gray-800/60 hover:bg-gray-800/30">
                    <td className="px-3 py-1.5 text-gray-200">{c.companyName}</td>
                    <td className="px-3 py-1.5 text-gray-400">{c.phone || '—'}</td>
                    <td className="px-3 py-1.5 text-gray-400">{c.city || '—'}</td>
                    <td className="px-3 py-1.5 text-gray-400">{c.contactName || '—'}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => handleDelete(c)}
                        className="text-gray-600 hover:text-red-400 transition-colors"
                        title="Remove from block list"
                      >×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
