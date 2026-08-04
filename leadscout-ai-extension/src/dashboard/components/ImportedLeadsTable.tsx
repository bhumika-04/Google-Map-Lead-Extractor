import React, { useEffect, useMemo, useState } from 'react'
import { importedLeadRepo } from '@/db/pipelineLeadRepository'
import { sessionRepository } from '@/db/sessionRepository'
import { saveStatusToSql } from '@/services/pipelineSyncService'
import { toast } from '@/state/useToastStore'
import type { ImportedLead } from '@/types/pipelineLead'
import type { SessionRecord } from '@/types/session'

// The global Lead Database / Selected / Research Queue views — imported leads ONLY
// (reads the imported_leads store). Scraped/session leads never appear here.

type Mode = 'leads' | 'selected' | 'research'

const MODE_TITLE: Record<Mode, string> = {
  leads: 'Imported Leads',
  selected: 'Selected (imported)',
  research: 'Research Queue (imported)',
}

function matchesMode(l: ImportedLead, mode: Mode): boolean {
  if (mode === 'selected') return l.status === 'selected'
  if (mode === 'research') return l.status === 'research_queued' || l.status === 'research_running' || l.status === 'research_completed'
  return true
}

const ICP_CLS = (s: number) =>
  s >= 80 ? 'bg-green-900/60 text-green-300'
  : s >= 60 ? 'bg-blue-900/60 text-blue-300'
  : s >= 50 ? 'bg-yellow-900/60 text-yellow-300'
  : 'bg-red-900/60 text-red-400'

export default function ImportedLeadsTable({ mode }: { mode: Mode }) {
  const [rows, setRows] = useState<ImportedLead[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [sessionFilter, setSessionFilter] = useState<number | 'all'>('all')
  const [q, setQ] = useState('')

  async function load() {
    const [all, sess] = await Promise.all([
      importedLeadRepo.getAll(),
      sessionRepository.getBySource('import'),
    ])
    setRows(all)
    setSessions(sess)
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows
      .filter((l) => matchesMode(l, mode))
      .filter((l) => sessionFilter === 'all' || l.sessionId === sessionFilter)
      .filter((l) => !needle || l.companyName.toLowerCase().includes(needle) || (l.city ?? '').toLowerCase().includes(needle))
      .sort((a, b) => (b.icpScore ?? -1) - (a.icpScore ?? -1))
  }, [rows, mode, sessionFilter, q])

  async function setStatus(l: ImportedLead, status: ImportedLead['status']) {
    if (!l.id) return
    await importedLeadRepo.update(l.id, { status })
    if (l.mssqlId) saveStatusToSql('imported', l.mssqlId, status).catch(() => {})
    load()
  }

  async function remove(l: ImportedLead) {
    if (!l.id || !confirm(`Delete "${l.companyName}"?`)) return
    await importedLeadRepo.delete(l.id)
    load()
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-white">{MODE_TITLE[mode]}</h2>
        <span className="text-xs text-gray-600">{filtered.length} leads</span>
        <span className="flex-1" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company or city…"
          className="bg-gray-800 border border-gray-700 text-white text-xs px-3 py-1.5 rounded-lg placeholder-gray-600 focus:outline-none focus:border-blue-500 w-56"
        />
        <select
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500 max-w-[200px]"
        >
          <option value="all">All import sessions</option>
          {sessions.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-gray-800 rounded-xl min-h-[220px]">
          <div className="text-sm text-gray-500 font-medium">No imported leads {mode !== 'leads' ? 'in this stage' : 'yet'}</div>
          <div className="text-xs text-gray-600 mt-1 max-w-md">
            Use the importer above to bring in a CSV/Excel list. Scraped session leads live in their session workspace, not here.
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto rounded-xl border border-gray-800">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-900 sticky top-0 z-10">
              <tr className="text-gray-500">
                <th className="px-3 py-2.5 font-medium">Company</th>
                <th className="px-3 py-2.5 font-medium w-16">ICP</th>
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 font-medium">City</th>
                <th className="px-3 py-2.5 font-medium">Phone</th>
                <th className="px-3 py-2.5 font-medium">Website</th>
                <th className="px-3 py-2.5 font-medium w-28">Status</th>
                <th className="px-3 py-2.5 font-medium w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} className="border-t border-gray-800/60 hover:bg-gray-800/40 transition-colors">
                  <td className="px-3 py-2 text-white font-medium">{l.companyName}</td>
                  <td className="px-3 py-2">{l.icpScore != null
                    ? <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${ICP_CLS(l.icpScore)}`}>{l.icpScore}</span>
                    : <span className="text-gray-700">—</span>}</td>
                  <td className="px-3 py-2 text-gray-400">{l.category ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-400">{l.city ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-300">{l.phone ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-400 truncate max-w-[160px]">
                    {l.website
                      ? <a href={l.website} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{l.website.replace(/^https?:\/\//, '')}</a>
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-400">{l.status}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {l.status !== 'selected' && (
                      <button onClick={() => setStatus(l, 'selected')} title="Mark selected"
                        className="text-green-400 hover:text-green-300 px-1">✓</button>
                    )}
                    <button onClick={() => remove(l)} title="Delete"
                      className="text-gray-600 hover:text-red-400 px-1">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
