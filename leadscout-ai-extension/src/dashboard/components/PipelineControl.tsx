import React, { useEffect, useState } from 'react'
import { MSG } from '@/types/messages'
import { toast } from '@/state/useToastStore'

// Shows the background pipeline status (enrichment → validation → research) from
// persisted storage, so it's accurate on ANY page even after the worker slept.
// Lets the user Stop a run or Re-run it, regardless of which page they're on.

interface PipelineState {
  status: 'idle' | 'running' | 'stopped' | 'done'
  phase?: string
  processed: number
  total: number
}

const PHASE_LABEL: Record<string, string> = {
  starting: 'Starting…',
  quick_enrichment_running: 'Enriching',
  validation_running: 'Validating',
  validation_completed: 'Validated',
  research_queued: 'Queuing research',
}

export default function PipelineControl() {
  const [state, setState] = useState<PipelineState | null>(null)

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

  if (!state || state.status === 'idle') return null

  const running = state.status === 'running'
  const label = running
    ? (PHASE_LABEL[state.phase ?? ''] ?? 'Running')
    : state.status === 'stopped' ? 'Stopped' : 'Done'
  const prog = state.total > 0 ? ` ${state.processed}/${state.total}` : ''

  async function stop() {
    await chrome.runtime.sendMessage({ type: MSG.PIPELINE_STOP }).catch(() => {})
    toast.info('Pipeline stop requested')
  }
  async function rerun() {
    await chrome.runtime.sendMessage({ type: MSG.PIPELINE_RUN }).catch(() => {})
    toast.info('Pipeline started')
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
        running ? 'bg-blue-950/70 border-blue-800 text-blue-300'
        : state.status === 'stopped' ? 'bg-red-950/70 border-red-800 text-red-300'
        : 'bg-green-950/70 border-green-800 text-green-300'}`}>
        {running && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
        {label}{prog}
      </span>
      {running ? (
        <button onClick={stop} className="px-2.5 py-1 rounded-lg bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800/50 transition-colors">Stop</button>
      ) : (
        <button onClick={rerun} className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">Re-run</button>
      )}
    </div>
  )
}
