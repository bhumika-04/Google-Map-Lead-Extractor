import React, { useEffect, useRef, useState } from 'react'
import { useLeadStore } from '@/state/useLeadStore'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { db } from '@/db/db'
import type { SearchProject } from '@/types/searchProject'

// Global Search Session switcher (lives in the Topbar). Picking a session
// scopes EVERY lead-listing page — Lead Database, Selected Leads, Research,
// Company Intelligence — to that one run until switched back to All Sessions.

const STATUS_DOT: Record<string, string> = {
  running:   'bg-green-400 animate-pulse',
  completed: 'bg-blue-400',
  stopped:   'bg-red-400',
}

const STATUS_LABEL: Record<string, string> = {
  running:   'Running',
  completed: 'Completed',
  stopped:   'Stopped',
}

export default function SessionSwitcher() {
  const { projectScope, setProjectScope } = useLeadStore()
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<SearchProject[]>([])
  const [unassignedCount, setUnassignedCount] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  async function load() {
    const all = await searchProjectRepository.getAll().catch(() => [] as SearchProject[])
    setProjects(all)
    const count = await db.leads.filter((l) => l.projectId === undefined).count().catch(() => 0)
    setUnassignedCount(count)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { if (open) load() }, [open])

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function choose(scope: { id: number; name: string } | null) {
    setProjectScope(scope)
    setOpen(false)
  }

  const active = projectScope
    ? projects.find((p) => p.id === projectScope.id)
    : undefined

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Filter every page by one search session"
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors max-w-[260px] ${
          projectScope
            ? 'bg-blue-950/70 border-blue-700 text-blue-200 hover:border-blue-500'
            : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          active ? STATUS_DOT[active.status] ?? 'bg-gray-500' : projectScope ? 'bg-gray-400' : 'bg-gray-500'
        }`} />
        <span className="truncate">{projectScope ? projectScope.name : 'All Sessions'}</span>
        <span className="text-gray-500 shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 left-0 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 text-[10px] uppercase tracking-wide text-gray-500">
            Search Sessions — scopes every page
          </div>
          <div className="max-h-80 overflow-y-auto">
            <button
              type="button"
              onClick={() => choose(null)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors ${
                !projectScope ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
              <span className="flex-1">All Sessions</span>
              <span className={`text-xs ${!projectScope ? 'text-blue-200' : 'text-gray-600'}`}>no filter</span>
            </button>

            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choose({ id: p.id!, name: p.name })}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors ${
                  projectScope?.id === p.id ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[p.status] ?? 'bg-gray-500'}`} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{p.name}</span>
                  <span className={`block text-[10px] ${projectScope?.id === p.id ? 'text-blue-200' : 'text-gray-600'}`}>
                    {STATUS_LABEL[p.status] ?? p.status} · {p.totalLeads} leads · {new Date(p.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                  </span>
                </span>
              </button>
            ))}

            {unassignedCount > 0 && (
              <button
                type="button"
                onClick={() => choose({ id: -1, name: 'Unassigned' })}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left border-t border-gray-800 transition-colors ${
                  projectScope?.id === -1 ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
                <span className="flex-1">Unassigned</span>
                <span className={`text-xs ${projectScope?.id === -1 ? 'text-blue-200' : 'text-gray-600'}`}>{unassignedCount} leads</span>
              </button>
            )}

            {projects.length === 0 && unassignedCount === 0 && (
              <div className="px-3 py-4 text-xs text-gray-600 text-center">
                No sessions yet — start a search in Search Console.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
