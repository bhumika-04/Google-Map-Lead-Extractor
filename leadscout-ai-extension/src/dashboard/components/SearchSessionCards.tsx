import React, { useEffect, useState } from 'react'
import type { NavSection } from './Sidebar'
import type { SearchProject } from '@/types/searchProject'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { db } from '@/db/db'
import { useLeadStore } from '@/state/useLeadStore'
import { toast } from '@/state/useToastStore'
import { updateSearchRunInSql } from '@/services/sqlSyncService'
import { flag } from './SearchConsole'

// Session cards shown below the Search Console — one card per search run,
// with the full pipeline state of that run: capture progress, then lead
// counts at every stage (captured → validated → qualified → researched).
// Clicking a stage scopes the whole dashboard to that session and jumps to
// the matching page.

interface StageCounts {
  captured: number
  validated: number
  qualified: number
  researched: number
}

const EMPTY_COUNTS: StageCounts = { captured: 0, validated: 0, qualified: 0, researched: 0 }

const STATUS_STYLE: Record<string, { dot: string; badge: string; label: string }> = {
  running:   { dot: 'bg-green-400 animate-pulse', badge: 'bg-green-950/70 border-green-800 text-green-300',  label: 'Running' },
  completed: { dot: 'bg-blue-400',                badge: 'bg-blue-950/70 border-blue-800 text-blue-300',     label: 'Completed' },
  stopped:   { dot: 'bg-red-400',                 badge: 'bg-red-950/70 border-red-800 text-red-300',        label: 'Stopped' },
}

export default function SearchSessionCards({ onNavigate }: { onNavigate: (s: NavSection) => void }) {
  const { setProjectScope } = useLeadStore()
  const [projects, setProjects] = useState<SearchProject[]>([])
  const [counts, setCounts] = useState<Map<number, StageCounts>>(new Map())
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [profileId, setProfileId] = useState<number | null>(null)
  const [profileValue, setProfileValue] = useState('')

  async function load() {
    const all = await searchProjectRepository.getAll().catch(() => [] as SearchProject[])
    setProjects(all)

    // One pass over all leads → per-session stage counts
    const leads = await db.leads.toArray().catch(() => [])
    const map = new Map<number, StageCounts>()
    for (const l of leads) {
      if (l.projectId === undefined) continue
      const c = map.get(l.projectId) ?? { ...EMPTY_COUNTS }
      c.captured++
      if (l.validationStatus === 'relevant' || l.validationStatus === 'not_relevant') c.validated++
      if (l.validationStatus === 'relevant') c.qualified++
      if (l.status === 'research_completed') c.researched++
      map.set(l.projectId, c)
    }
    setCounts(map)
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 4000)
    return () => clearInterval(interval)
  }, [])

  function openScoped(project: SearchProject, section: NavSection) {
    setProjectScope({ id: project.id!, name: project.name })
    onNavigate(section)
  }

  async function saveRename(project: SearchProject) {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name || name === project.name) return
    await searchProjectRepository.rename(project.id!, name)
    if (project.mssqlRunId !== undefined) updateSearchRunInSql(project.mssqlRunId, { name }).catch(() => {})
    load()
  }

  async function saveProfile(project: SearchProject) {
    await searchProjectRepository.update(project.id!, { businessProfile: profileValue })
    if (project.mssqlRunId !== undefined) updateSearchRunInSql(project.mssqlRunId, { businessProfile: profileValue }).catch(() => {})
    setProfileId(null)
    toast.success('Session ICP updated — used for this session’s next validation & research')
    load()
  }

  async function handleDelete(project: SearchProject) {
    const c = counts.get(project.id!) ?? EMPTY_COUNTS
    const ok = confirm(
      `Delete session "${project.name}"?\n\n` +
      `Its ${c.captured} leads are NOT deleted — they move to "Unassigned".\n` +
      `Only the session card and its ICP profile are removed.`
    )
    if (!ok) return
    await searchProjectRepository.delete(project.id!)
    toast.info(`Session "${project.name}" deleted — its leads are now under Unassigned`)
    load()
  }

  if (projects.length === 0) {
    // Sessions are created when a run STARTS — leads captured before this
    // feature existed have no session and live under "Unassigned" in the
    // topbar switcher. Show that instead of silently rendering nothing.
    return (
      <div className="space-y-2">
        <h2 className="font-semibold text-white text-sm">Search Sessions</h2>
        <div className="bg-gray-900/60 border border-dashed border-gray-800 rounded-xl px-4 py-5 text-center">
          <div className="text-sm text-gray-500 font-medium">No sessions yet</div>
          <div className="text-xs text-gray-600 mt-1 max-w-xl mx-auto leading-relaxed">
            Every <span className="text-gray-400">▶ Start Full Pipeline</span> run now creates its own session card here — separate leads,
            its own ICP, and live pipeline progress (captured → validated → qualified → researched).
            Leads captured before this feature appear under <span className="text-gray-400">Unassigned</span> in the session switcher in the top bar.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-white text-sm">Search Sessions</h2>
        <span className="text-xs text-gray-600">{projects.length} session{projects.length > 1 ? 's' : ''} — each keeps its own leads, ICP and research</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {projects.map((p) => {
          const c = counts.get(p.id!) ?? EMPTY_COUNTS
          const style = STATUS_STYLE[p.status] ?? STATUS_STYLE.stopped
          const termPct = p.totalTerms > 0 ? Math.round((p.completedTerms / p.totalTerms) * 100) : 0
          const isRenaming = renamingId === p.id
          const isEditingProfile = profileId === p.id

          return (
            <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3 hover:border-gray-700 transition-colors">
              {/* Header: name + status */}
              <div className="flex items-start gap-2">
                <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${style.dot}`} />
                <div className="flex-1 min-w-0">
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveRename(p); if (e.key === 'Escape') setRenamingId(null) }}
                      onBlur={() => saveRename(p)}
                      className="w-full bg-gray-800 border border-blue-600 text-white text-sm px-2 py-1 rounded-lg focus:outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-semibold text-white truncate">{flag(p.country)} {p.name}</span>
                      <button
                        onClick={() => { setRenamingId(p.id!); setRenameValue(p.name) }}
                        className="text-gray-600 hover:text-gray-300 text-xs shrink-0"
                        title="Rename session"
                      >✎</button>
                    </div>
                  )}
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {p.keywords.length} keyword{p.keywords.length > 1 ? 's' : ''} · {p.cities.length} cit{p.cities.length > 1 ? 'ies' : 'y'} ·{' '}
                    {p.source === 'batch_campaign' ? 'Batch Campaign' : 'Search Console'} ·{' '}
                    {new Date(p.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${style.badge}`}>{style.label}</span>
              </div>

              {/* Capture progress while running */}
              {p.status === 'running' && p.totalTerms > 1 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-gray-500">
                    <span>Capturing — search {Math.min(p.completedTerms + 1, p.totalTerms)} of {p.totalTerms}</span>
                    <span>{termPct}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full transition-all duration-700" style={{ width: `${termPct}%` }} />
                  </div>
                </div>
              )}

              {/* Pipeline stages — click a stage to open it scoped to this session */}
              <div className="grid grid-cols-4 gap-1.5">
                <StageChip icon="⌕" label="Captured"   value={c.captured}   onClick={() => openScoped(p, 'leads')} />
                <StageChip icon="✓" label="Validated"  value={c.validated}  onClick={() => openScoped(p, 'leads')} />
                <StageChip icon="★" label="Qualified"  value={c.qualified}  onClick={() => openScoped(p, 'selected')} />
                <StageChip icon="⚗" label="Researched" value={c.researched} onClick={() => openScoped(p, 'research_results')} />
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => openScoped(p, 'leads')}
                  className="text-xs px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded-lg font-medium transition-colors"
                >
                  Open Workspace →
                </button>
                <button
                  onClick={() => openScoped(p, 'company_intelligence')}
                  className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
                >
                  Intelligence
                </button>
                <button
                  onClick={() => {
                    if (isEditingProfile) { setProfileId(null) }
                    else { setProfileId(p.id!); setProfileValue(p.businessProfile) }
                  }}
                  className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
                    isEditingProfile ? 'bg-purple-800 text-purple-200' : 'bg-gray-800 hover:bg-gray-700 text-purple-300'
                  }`}
                  title="View / edit this session's ICP profile"
                >
                  🎯 ICP
                </button>
                <span className="flex-1" />
                <button
                  onClick={() => handleDelete(p)}
                  className="text-xs px-2 py-1.5 text-gray-700 hover:text-red-400 transition-colors"
                  title="Delete session (leads are kept as Unassigned)"
                >
                  ✕
                </button>
              </div>

              {/* Inline ICP editor */}
              {isEditingProfile && (
                <div className="space-y-1.5 pt-1 border-t border-gray-800">
                  <textarea
                    value={profileValue}
                    onChange={(e) => setProfileValue(e.target.value)}
                    rows={7}
                    className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-xs px-2.5 py-2 rounded-lg leading-relaxed
                      focus:outline-none focus:border-purple-600"
                  />
                  <div className="flex gap-1.5">
                    <button onClick={() => saveProfile(p)} className="text-xs px-3 py-1 bg-purple-700 hover:bg-purple-600 text-white rounded-lg">Save ICP</button>
                    <button onClick={() => setProfileId(null)} className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StageChip({ icon, label, value, onClick }: { icon: string; label: string; value: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-0.5 px-1 py-2 bg-gray-950/70 border border-gray-800 rounded-lg
        hover:border-blue-700 hover:bg-blue-950/30 transition-colors group"
      title={`Open ${label.toLowerCase()} leads for this session`}
    >
      <span className="text-sm font-semibold text-white group-hover:text-blue-300">{value}</span>
      <span className="text-[10px] text-gray-600 group-hover:text-blue-400">{icon} {label}</span>
    </button>
  )
}
