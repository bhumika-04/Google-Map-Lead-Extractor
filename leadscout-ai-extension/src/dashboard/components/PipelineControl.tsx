import React, { useEffect, useState } from 'react'
import { MSG } from '@/types/messages'
import { toast } from '@/state/useToastStore'

// Background pipeline (enrichment → validation → research) status + controls,
// read from persisted storage so it's accurate on ANY page even after the worker
// slept. Two modes:
//   • Topbar (no projectId): compact global status + Stop.
//   • Session workspace (projectId set): Stop / Continue / Re-run for that session.

interface LeadValidationResult {
  name: string
  relevant: boolean
  icpScore: number
  reason: string
}

interface PipelineState {
  status: 'idle' | 'running' | 'stopped' | 'done'
  phase?: string
  processed: number
  total: number
  projectId?: number
  recentResults?: LeadValidationResult[]
  relevantCount?: number
}

const PHASE_LABEL: Record<string, string> = {
  starting: 'Starting…',
  quick_enrichment_running: 'Enriching',
  validation_running: 'Validating',
  validation_completed: 'Validated',
  research_queued: 'Queuing research',
  verifying: 'Verifying from Google',
  qualifying: 'Qualifying leads',
}

export default function PipelineControl({ projectId }: { projectId?: number }) {
  const [state, setState] = useState<PipelineState | null>(null)
  const sessionMode = projectId !== undefined

  useEffect(() => {
    const read = () => chrome.storage.local.get('pipeline_state').then((o) => setState(o.pipeline_state ?? null)).catch(() => {})
    read()
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.pipeline_state) setState(changes.pipeline_state.newValue ?? null)
    }
    chrome.storage.onChanged.addListener(onChange)
    const t = setInterval(read, 3000)
    return () => { chrome.storage.onChanged.removeListener(onChange); clearInterval(t) }
  }, [])

  // Does the current run belong to this control's scope?
  const isThisScope = !sessionMode || state?.projectId === projectId
  const runningHere = state?.status === 'running' && isThisScope
  const statusHere = isThisScope ? state : null

  // Topbar: hide entirely when nothing relevant is happening.
  if (!sessionMode && (!state || state.status === 'idle')) return null

  async function send(type: string, payload?: unknown) {
    await chrome.runtime.sendMessage(payload ? { type, payload } : { type }).catch(() => {})
  }
  const stop = async () => { await send(MSG.PIPELINE_STOP); toast.info('Pipeline stop requested') }
  const cont = async () => { await send(MSG.PIPELINE_RUN, { projectId, force: false }); toast.info('Continuing pipeline…') }
  const rerun = async () => {
    if (!confirm('Re-run the whole pipeline for this session? Every lead will be re-enriched and re-validated.')) return
    await send(MSG.PIPELINE_RUN, { projectId, force: true }); toast.info('Re-running pipeline…')
  }

  const label = runningHere
    ? (PHASE_LABEL[statusHere?.phase ?? ''] ?? 'Running')
    : statusHere?.status === 'stopped' ? 'Stopped'
    : statusHere?.status === 'done' ? 'Done'
    : 'Idle'
  const prog = runningHere && (statusHere?.total ?? 0) > 0 ? ` ${statusHere!.processed}/${statusHere!.total}` : ''

  const pill = (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-xs ${
      runningHere ? 'bg-blue-950/70 border-blue-800 text-blue-300'
      : statusHere?.status === 'stopped' ? 'bg-red-950/70 border-red-800 text-red-300'
      : statusHere?.status === 'done' ? 'bg-green-950/70 border-green-800 text-green-300'
      : 'bg-gray-800 border-gray-700 text-gray-400'}`}>
      {runningHere && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
      {label}{prog}
    </span>
  )

  // Progress bar while running — determinate when a total is known, otherwise a
  // subtle indeterminate pulse (e.g. the brief 'starting' phase).
  const total = statusHere?.total ?? 0
  const processed = statusHere?.processed ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0
  const bar = (width: string) => (
    <div className={`${width} h-1.5 rounded-full bg-gray-800 overflow-hidden`}>
      {total > 0
        ? <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        : <div className="h-full w-1/3 bg-blue-500/70 rounded-full animate-pulse" />}
    </div>
  )

  // Topbar (global) — status + Stop while running.
  if (!sessionMode) {
    return (
      <div className="flex items-center gap-2">
        {pill}
        {runningHere && bar('w-24')}
        {state?.status === 'running' && (
          <button onClick={stop} className="text-xs px-2.5 py-1 rounded-lg bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800/50 transition-colors">Stop</button>
        )}
      </div>
    )
  }

  // Session workspace — Stop / Continue / Re-run.
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {pill}
      {runningHere && bar('w-44')}
      {runningHere ? (
        <button onClick={stop} className="text-sm px-4 py-2 rounded-lg font-medium bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800/50 transition-colors">Stop</button>
      ) : (
        <>
          <button onClick={cont} className="text-sm px-4 py-2 rounded-lg font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">Continue</button>
          <button onClick={rerun} className="text-sm px-4 py-2 rounded-lg font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 transition-colors">Re-run all</button>
        </>
      )}
    </div>
  )
}

// Live "why qualified / why rejected" feed for a validation run — one line per
// lead as it's scored, newest first, plus a running relevant count and
// progress bar. Populated only while/after a validation step runs; silently
// renders nothing otherwise (enrichment/research runs never populate it).
export function ValidationFeed({ projectId }: { projectId?: number }) {
  const [state, setState] = useState<PipelineState | null>(null)

  useEffect(() => {
    const read = () => chrome.storage.local.get('pipeline_state').then((o) => setState(o.pipeline_state ?? null)).catch(() => {})
    read()
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.pipeline_state) setState(changes.pipeline_state.newValue ?? null)
    }
    chrome.storage.onChanged.addListener(onChange)
    const t = setInterval(read, 2000)
    return () => { chrome.storage.onChanged.removeListener(onChange); clearInterval(t) }
  }, [])

  const isThisScope = projectId === undefined || state?.projectId === projectId
  const results = isThisScope ? (state?.recentResults ?? []) : []
  if (results.length === 0) return null

  const running = state?.status === 'running'
  const total = state?.total ?? 0
  const processed = state?.processed ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0

  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white flex items-center gap-2">
          {running && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
          {running ? 'Validating leads…' : 'Last validation run'}
        </span>
        <span className="text-xs text-green-400 font-medium">{state?.relevantCount ?? 0} relevant</span>
      </div>
      {running && (
        <div className="space-y-1">
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-gray-500">{pct}% complete</div>
        </div>
      )}
      <div className="max-h-72 overflow-y-auto space-y-1">
        {results.map((r, i) => (
          <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-gray-900/60 text-xs">
            <span className={`shrink-0 ${r.relevant ? 'text-green-400' : 'text-gray-600'}`}>{r.relevant ? '✓' : '✕'}</span>
            <span className="text-white font-medium shrink-0">{r.name}</span>
            <span className="text-gray-700 shrink-0">·</span>
            <span className="text-gray-500 truncate">{r.reason}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
