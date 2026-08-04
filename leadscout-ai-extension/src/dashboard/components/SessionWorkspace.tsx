import React, { useEffect, useMemo, useState } from 'react'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { leadRepository } from '@/db/leadRepository'
import { selectedLeadRepository } from '@/db/selectedLeadRepository'
import { researchedLeadRepository } from '@/db/researchedLeadRepository'
import { addToResearchQueue } from '@/services/futureResearchService'
import { syncDerivedLeads } from '@/services/derivedLeadsService'
import { useLeadStore } from '@/state/useLeadStore'
import { toast } from '@/state/useToastStore'
import { MSG } from '@/types/messages'
import { COUNTRIES, flag } from './SearchConsole'
import { timeAgo } from '@/utils/date'
import LeadTable from './LeadTable'
import PipelineControl from './PipelineControl'
import type { SearchProject } from '@/types/searchProject'
import type { Lead } from '@/types/lead'
import type { SelectedLead, ResearchedLead } from '@/types/derivedLeads'

// A self-contained workspace for ONE Search Session. Everything — the pipeline
// funnel, all leads, selected leads — lives inside here as tabs, scoped to this
// session, so opening a session never navigates you away to a global page.

const COUNTRY_NAME: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]))

type Tab = 'overview' | 'leads' | 'selected' | 'researched'

function computeStats(leads: Lead[]) {
  const isResearch = (s: string) => s.startsWith('research')
  return {
    captured: leads.length,
    enriched: leads.filter((l) => l.teamSize || l.annualTurnover || l.industry || l.decisionMaker).length,
    scored: leads.filter((l) => l.icpScore !== undefined).length,
    relevant: leads.filter((l) => l.validationStatus === 'relevant' || l.status === 'selected' || isResearch(l.status)).length,
    researched: leads.filter((l) => l.status === 'research_completed').length,
  }
}

export default function SessionWorkspace({ projectId, onExit }: { projectId: number; onExit: () => void }) {
  const { setProjectScope } = useLeadStore()
  const [project, setProject] = useState<SearchProject | null>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [tab, setTab] = useState<Tab>('overview')
  const [queuing, setQueuing] = useState(false)
  const [selRows, setSelRows] = useState<SelectedLead[]>([])
  const [resRows, setResRows] = useState<ResearchedLead[]>([])

  // Scope every lead view to this session while the workspace is open.
  useEffect(() => {
    let cancelled = false
    searchProjectRepository.getById(projectId).then((p) => {
      if (cancelled || !p) return
      setProject(p)
      setProjectScope({ id: p.id!, name: p.name })
    })
    return () => { cancelled = true }
  }, [projectId, setProjectScope])

  // Load + poll this session's leads for the live funnel.
  useEffect(() => {
    let cancelled = false
    const run = () => leadRepository.getByFilter({ projectId }).then((r) => { if (!cancelled) setLeads(r) })
    run()
    const t = setInterval(run, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [projectId])

  // Rebuild the dedicated tables once, then poll this session's selected/researched rows.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [sel, res] = await Promise.all([
        selectedLeadRepository.getBySession(projectId),
        researchedLeadRepository.getBySession(projectId),
      ])
      if (!cancelled) { setSelRows(sel); setResRows(res) }
    }
    syncDerivedLeads().then(load).catch(load)
    const t = setInterval(load, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [projectId])

  const s = useMemo(() => computeStats(leads), [leads])

  function exit() {
    setProjectScope(null)   // leaving the workspace un-scopes the global lead views
    onExit()
  }

  async function queueRelevantForResearch() {
    if (queuing) return
    const toQueue = leads.filter((l) => (l.validationStatus === 'relevant' || l.status === 'selected') && !l.status.startsWith('research'))
    if (toQueue.length === 0) { toast.info('No relevant leads waiting to be queued'); return }
    setQueuing(true)
    let n = 0
    for (const l of toQueue) { try { await addToResearchQueue(l); n++ } catch { /* already queued */ } }
    if (n > 0) chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
    setQueuing(false)
    toast.success(`${n} leads queued for research`)
  }

  const funnel = [
    { label: 'Captured',   value: s.captured,   grad: 'from-slate-500 to-slate-400' },
    { label: 'Enriched',   value: s.enriched,   grad: 'from-sky-500 to-cyan-400' },
    { label: 'Scored',     value: s.scored,     grad: 'from-indigo-500 to-blue-400' },
    { label: 'Relevant',   value: s.relevant,   grad: 'from-emerald-500 to-green-400' },
    { label: 'Researched', value: s.researched, grad: 'from-violet-500 to-purple-400' },
  ]
  const denom = Math.max(s.captured, 1)

  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['leads', `Leads (${s.captured})`],
    ['selected', `Selected (${selRows.length})`],
    ['researched', `Researched (${resRows.length})`],
  ]

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4 animate-fade-in-up">
      {/* Header — session identity, funnel, tabs */}
      <div className="relative overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 p-5 shadow-lg shadow-black/20 shrink-0">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500" />

        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={exit} className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">
            ← Sessions
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg leading-none">{project ? flag(project.country) : ''}</span>
            <h2 className="text-base font-semibold text-white truncate">{project?.name ?? 'Session'}</h2>
          </div>
          {project && (
            <span className="text-[11px] text-gray-500">
              {COUNTRY_NAME[project.country] ?? project.country} · {project.cities.length} {project.cities.length === 1 ? 'city' : 'cities'} · {timeAgo(project.createdAt)}
            </span>
          )}
        </div>

        {/* Funnel */}
        <div className="mt-4 grid grid-cols-5 gap-2">
          {funnel.map((f) => (
            <div key={f.label} className="text-center">
              <div className="text-xl font-bold text-white leading-none">{f.value}</div>
              <div className="text-[10px] text-gray-500 mt-1 mb-1.5">{f.label}</div>
              <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                <div className={`h-full rounded-full bg-gradient-to-r ${f.grad} transition-all duration-700`} style={{ width: `${Math.round((f.value / denom) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="mt-4 flex items-center gap-1 border-b border-gray-800">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`relative px-3.5 py-2 text-xs font-medium transition-colors ${tab === id ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {label}
              {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-blue-500 to-violet-500" />}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <WTile label="Relevant"   value={s.relevant}   accent="text-emerald-400" onClick={() => setTab('selected')} />
            <WTile label="Scored"     value={s.scored}     accent="text-indigo-400"  onClick={() => setTab('leads')} />
            <WTile label="Enriched"   value={s.enriched}   accent="text-sky-400"     onClick={() => setTab('leads')} />
            <WTile label="Researched" value={s.researched} accent="text-violet-400"  onClick={() => setTab('leads')} />
          </div>
          {/* Per-session pipeline controls — Stop / Continue / Re-run */}
          <div className="flex items-center gap-3 flex-wrap bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <span className="text-sm text-gray-400 font-medium">Pipeline</span>
            <PipelineControl projectId={projectId} />
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <button onClick={() => setTab('leads')} className="text-sm px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg border border-gray-700 font-medium transition-colors">View all leads</button>
            <button onClick={() => setTab('selected')} className="text-sm px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg border border-gray-700 font-medium transition-colors">View selected</button>
            <button
              onClick={queueRelevantForResearch}
              disabled={queuing}
              className="text-sm px-4 py-2 rounded-lg font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 transition-colors"
            >
              {queuing ? 'Queuing…' : 'Queue relevant for research'}
            </button>
            <button
              onClick={() => { chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {}); toast.success('Research triggered') }}
              className="text-sm px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg border border-gray-700 font-medium transition-colors"
            >Run research now</button>
          </div>
          {project?.businessProfile?.trim() && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1">Session ICP / business profile</div>
              <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap line-clamp-4">{project.businessProfile}</p>
            </div>
          )}
        </div>
      )}
      {tab === 'leads' && <LeadTable title="Leads in this session" />}
      {tab === 'selected' && <SelectedTable rows={selRows} />}
      {tab === 'researched' && <ResearchedTable rows={resRows} />}
    </div>
  )
}

// ─── Dedicated per-stage tables (read from selectedLeads / researchedLeads) ─────

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-gray-600 border border-gray-800 rounded-xl min-h-[160px]">
      {label}
    </div>
  )
}

function IcpBadge({ score }: { score: number }) {
  const cls = score >= 80 ? 'bg-green-900/60 text-green-300'
    : score >= 60 ? 'bg-blue-900/60 text-blue-300'
    : score >= 50 ? 'bg-yellow-900/60 text-yellow-300'
    : 'bg-red-900/60 text-red-400'
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}`}>{score}</span>
}

function SelectedTable({ rows }: { rows: SelectedLead[] }) {
  if (rows.length === 0) return <EmptyState label="No selected leads in this session yet — validate leads to populate this table." />
  return (
    <div className="flex-1 overflow-auto rounded-xl border border-gray-800">
      <table className="w-full text-xs text-left">
        <thead className="bg-gray-900 sticky top-0 z-10">
          <tr className="text-gray-500">
            <th className="px-3 py-2.5 font-medium">Company</th>
            <th className="px-3 py-2.5 font-medium w-20">ICP</th>
            <th className="px-3 py-2.5 font-medium">Category</th>
            <th className="px-3 py-2.5 font-medium">Phone</th>
            <th className="px-3 py-2.5 font-medium">City</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.leadId} className="border-t border-gray-800/60 hover:bg-gray-800/40 transition-colors">
              <td className="px-3 py-2 text-white font-medium">{r.companyName}</td>
              <td className="px-3 py-2">{r.icpScore != null ? <IcpBadge score={r.icpScore} /> : <span className="text-gray-700">—</span>}</td>
              <td className="px-3 py-2 text-gray-400">{r.category ?? '—'}</td>
              <td className="px-3 py-2 text-gray-300">{r.phone ?? '—'}</td>
              <td className="px-3 py-2 text-gray-400">{r.city ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResearchedTable({ rows }: { rows: ResearchedLead[] }) {
  if (rows.length === 0) return <EmptyState label="No researched leads in this session yet — queue relevant leads for research." />
  return (
    <div className="flex-1 overflow-auto rounded-xl border border-gray-800">
      <table className="w-full text-xs text-left">
        <thead className="bg-gray-900 sticky top-0 z-10">
          <tr className="text-gray-500">
            <th className="px-3 py-2.5 font-medium">Company</th>
            <th className="px-3 py-2.5 font-medium">Decision maker</th>
            <th className="px-3 py-2.5 font-medium">Email</th>
            <th className="px-3 py-2.5 font-medium">Industry</th>
            <th className="px-3 py-2.5 font-medium">Turnover</th>
            <th className="px-3 py-2.5 font-medium">Team</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.leadId} className="border-t border-gray-800/60 hover:bg-gray-800/40 transition-colors">
              <td className="px-3 py-2 text-white font-medium">{r.companyName}</td>
              <td className="px-3 py-2 text-gray-300">{r.decisionMaker ?? '—'}</td>
              <td className="px-3 py-2 text-gray-300 truncate max-w-[160px]">{r.email ?? '—'}</td>
              <td className="px-3 py-2 text-gray-400">{r.industry ?? '—'}</td>
              <td className="px-3 py-2 text-gray-400">{r.annualTurnover ?? '—'}</td>
              <td className="px-3 py-2 text-gray-400">{r.teamSize ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WTile({ label, value, accent, onClick }: { label: string; value: number; accent: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-left transition-all duration-200
        hover:border-indigo-600/50 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20"
    >
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs text-white mt-0.5">{label}</div>
    </button>
  )
}
