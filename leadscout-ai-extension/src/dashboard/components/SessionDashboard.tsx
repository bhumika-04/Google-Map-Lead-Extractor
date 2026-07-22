import React, { useEffect, useMemo, useState } from 'react'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { leadRepository } from '@/db/leadRepository'
import { addToResearchQueue } from '@/services/futureResearchService'
import { toast } from '@/state/useToastStore'
import { MSG } from '@/types/messages'
import { COUNTRIES, flag } from './SearchConsole'
import { timeAgo } from '@/utils/date'
import type { SearchProject } from '@/types/searchProject'
import type { Lead } from '@/types/lead'
import type { NavSection } from './Sidebar'

const COUNTRY_NAME: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]))

interface Stats {
  captured: number
  enriched: number
  scored: number
  relevant: number
  rejected: number
  researchPending: number
  researchRunning: number
  researchDone: number
  researchFailed: number
}

function computeStats(leads: Lead[]): Stats {
  const isResearch = (s: string) => s.startsWith('research')
  return {
    captured: leads.length,
    enriched: leads.filter((l) => l.teamSize || l.annualTurnover || l.industry || l.decisionMaker).length,
    scored: leads.filter((l) => l.icpScore !== undefined).length,
    relevant: leads.filter((l) => l.validationStatus === 'relevant' || l.status === 'selected' || isResearch(l.status)).length,
    rejected: leads.filter((l) => l.validationStatus === 'not_relevant' || l.status === 'rejected').length,
    researchPending: leads.filter((l) => l.status === 'research_pending').length,
    researchRunning: leads.filter((l) => l.status === 'research_running').length,
    researchDone: leads.filter((l) => l.status === 'research_completed').length,
    researchFailed: leads.filter((l) => l.status === 'research_failed').length,
  }
}

interface SessionDashboardProps {
  onNavigate: (section: NavSection) => void
  onOpenWorkspace: (projectId: number) => void
}

export default function SessionDashboard({ onNavigate, onOpenWorkspace }: SessionDashboardProps) {
  const [projects, setProjects] = useState<SearchProject[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [queuing, setQueuing] = useState(false)

  async function loadProjects() {
    const all = await searchProjectRepository.getAll().catch(() => [])
    setProjects(all)
    setSelectedId((prev) => prev ?? all[0]?.id ?? null)
    setLoading(false)
  }
  useEffect(() => { loadProjects() }, [])

  async function loadLeadsFor(id: number) {
    const rows = await leadRepository.getByFilter({ projectId: id })
    setLeads(rows)
  }

  // Load + poll the selected session's leads for live pipeline progress.
  useEffect(() => {
    if (selectedId === null) { setLeads([]); return }
    let cancelled = false
    const run = () => leadRepository.getByFilter({ projectId: selectedId }).then((r) => { if (!cancelled) setLeads(r) })
    run()
    const t = setInterval(run, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [selectedId])

  const project = useMemo(() => projects.find((p) => p.id === selectedId) ?? null, [projects, selectedId])
  const stats = useMemo(() => computeStats(leads), [leads])

  function openWorkspace() {
    if (project?.id !== undefined) onOpenWorkspace(project.id)
  }

  async function queueRelevantForResearch() {
    if (queuing) return
    const toQueue = leads.filter(
      (l) => (l.validationStatus === 'relevant' || l.status === 'selected') && !l.status.startsWith('research'),
    )
    if (toQueue.length === 0) { toast.info('No relevant leads waiting to be queued'); return }
    setQueuing(true)
    let queued = 0
    for (const lead of toQueue) {
      try { await addToResearchQueue(lead); queued++ } catch { /* already queued */ }
    }
    if (queued > 0) chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
    if (selectedId !== null) await loadLeadsFor(selectedId)
    setQueuing(false)
    toast.success(`${queued} leads queued for research`)
  }

  if (loading) {
    return (
      <div className="grid grid-cols-4 gap-3">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <div key={i} className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />)}
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-700 bg-gray-900 border border-gray-800 rounded-xl">
        <div className="text-4xl mb-2 opacity-30">◱</div>
        <div className="text-sm text-gray-500">No sessions yet</div>
        <button onClick={() => onNavigate('search')} className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors">
          Start a search in Search Console →
        </button>
      </div>
    )
  }

  // Funnel stages (each ≤ the previous) — captured → enriched → scored → relevant → researched
  const funnel = [
    { label: 'Captured',  value: stats.captured,     color: 'bg-gray-500' },
    { label: 'Enriched',  value: stats.enriched,     color: 'bg-sky-500' },
    { label: 'Scored',    value: stats.scored,       color: 'bg-indigo-500' },
    { label: 'Relevant',  value: stats.relevant,     color: 'bg-green-500' },
    { label: 'Researched',value: stats.researchDone, color: 'bg-purple-500' },
  ]
  const denom = Math.max(stats.captured, 1)

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-y-auto animate-fade-in-up">
      {/* Session picker + meta */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label className="block text-xs text-gray-500 mb-1">Session</label>
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-blue-500 w-full max-w-md"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {project && (
            <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 flex-wrap">
              <span className="text-base leading-none">{flag(project.country)}</span>
              <span>{COUNTRY_NAME[project.country] ?? project.country}</span>
              <span className="text-gray-700">·</span>
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                project.status === 'running' ? 'bg-blue-900/60 text-blue-300' :
                project.status === 'stopped' ? 'bg-yellow-900/60 text-yellow-300' : 'bg-gray-800 text-gray-400'
              }`}>{project.status}</span>
              <span className="text-gray-700">·</span>
              <span>{project.completedTerms}/{project.totalTerms || '—'} terms</span>
              <span className="text-gray-700">·</span>
              <span>{timeAgo(project.createdAt)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Funnel bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-end justify-between gap-2 mb-2">
          {funnel.map((s) => (
            <div key={s.label} className="flex-1 text-center">
              <div className="text-lg font-bold text-white">{s.value}</div>
              <div className="text-[11px] text-gray-500">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          {funnel.map((s) => (
            <div key={s.label} className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className={`h-full ${s.color} rounded-full transition-all`} style={{ width: `${Math.round((s.value / denom) * 100)}%` }} />
            </div>
          ))}
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Relevant" value={stats.relevant} sub="validated in" color="text-green-400" onClick={openWorkspace} />
        <StatTile label="Rejected" value={stats.rejected} sub="not relevant" color="text-gray-400" onClick={openWorkspace} />
        <StatTile label="Research running" value={stats.researchRunning} sub={`${stats.researchPending} pending`} color={stats.researchRunning > 0 ? 'text-purple-400 animate-pulse' : 'text-gray-500'} onClick={openWorkspace} />
        <StatTile label="Researched" value={stats.researchDone} sub={stats.researchFailed > 0 ? `${stats.researchFailed} failed` : 'completed'} color="text-purple-300" onClick={openWorkspace} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={openWorkspace} className="text-xs px-3 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg transition-all active:scale-95">
          Open workspace →
        </button>
        <button
          onClick={queueRelevantForResearch}
          disabled={queuing}
          className="text-xs px-3 py-1.5 bg-purple-800 hover:bg-purple-700 disabled:opacity-50 text-purple-100 rounded-lg transition-colors"
        >
          {queuing ? 'Queuing…' : 'Queue relevant for research'}
        </button>
        <button
          onClick={() => { chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {}); toast.success('Research triggered') }}
          className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors border border-gray-700"
        >
          ▶ Run research now
        </button>
      </div>

      {/* Per-session ICP */}
      {project?.businessProfile?.trim() && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 font-medium mb-1">Session ICP / business profile</div>
          <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap line-clamp-4">{project.businessProfile}</p>
        </div>
      )}
    </div>
  )
}

function StatTile({ label, value, sub, color, onClick }: { label: string; value: number; sub: string; color: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-left transition-all duration-200
      hover:border-indigo-600/50 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-white mt-0.5">{label}</div>
      <div className="text-[11px] text-gray-600">{sub}</div>
    </button>
  )
}
