import React, { useEffect, useState } from 'react'
import { MSG } from '@/types/messages'
import { toast } from '@/state/useToastStore'

// Background pipeline (enrichment → validation → research) status + controls,
// read from persisted storage so it's accurate on ANY page even after the worker
// slept. Two modes:
//   • Topbar (no projectId): compact global status + Stop.
//   • Session workspace (projectId set): Stop / Continue / Re-run for that session.

interface PipelineState {
  status: 'idle' | 'running' | 'stopped' | 'done'
  phase?: string
  processed: number
  total: number
  projectId?: number
}

const PHASE_LABEL: Record<string, string> = {
  starting: 'Starting…',
  quick_enrichment_running: 'Enriching',
  validation_running: 'Validating',
  validation_completed: 'Validated',
  research_queued: 'Queuing research',
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

  // Topbar (global) — status + Stop while running.
  if (!sessionMode) {
    return (
      <div className="flex items-center gap-2">
        {pill}
        {state?.status === 'running' && (
          <button onClick={stop} className="text-xs px-2.5 py-1 rounded-lg bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800/50 transition-colors">Stop</button>
        )}
      </div>
    )
  }

  // Session workspace — Stop / Continue / Re-run.
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pill}
      {runningHere ? (
        <button onClick={stop} className="text-xs px-3 py-1.5 rounded-lg bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800/50 transition-colors">Stop</button>
      ) : (
        <>
          <button onClick={cont} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">Continue</button>
          <button onClick={rerun} className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">Re-run all</button>
        </>
      )}
    </div>
  )
}
