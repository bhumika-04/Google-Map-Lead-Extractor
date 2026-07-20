import { create } from 'zustand'

export type CaptureStatus = 'idle' | 'opening_maps' | 'running' | 'stopped' | 'completed' | 'error'

// Post-capture pipeline phases (shown in UI after Maps scraping ends)
export type PipelinePhase =
  | 'maps_capture_running'
  | 'maps_capture_completed'
  | 'quick_enrichment_running'
  | 'validation_running'
  | 'validation_completed'
  | 'research_queued'
  | 'research_running'
  | 'research_completed'
  | null

interface CaptureState {
  status: CaptureStatus
  pipelinePhase: PipelinePhase
  sessionId: number | null
  totalCaptured: number
  duplicatesSkipped: number
  mapsTabId: number | null
  lastMessage: string
  logs: string[]
  setStatus: (status: CaptureStatus) => void
  setPipelinePhase: (phase: PipelinePhase) => void
  setSession: (sessionId: number) => void
  setMapsTabId: (tabId: number | null) => void
  updateProgress: (captured: number, dupes: number, msg?: string) => void
  appendLog: (msg: string) => void
  reset: () => void
}

export const useCaptureStore = create<CaptureState>((set) => ({
  status: 'idle',
  pipelinePhase: null,
  sessionId: null,
  totalCaptured: 0,
  duplicatesSkipped: 0,
  mapsTabId: null,
  lastMessage: '',
  logs: [],

  setStatus(status) {
    set({ status })
  },

  setPipelinePhase(phase) {
    set({ pipelinePhase: phase })
  },

  setSession(sessionId) {
    set({ sessionId })
  },

  setMapsTabId(tabId) {
    set({ mapsTabId: tabId })
  },

  updateProgress(captured, dupes, msg) {
    set({ totalCaptured: captured, duplicatesSkipped: dupes, lastMessage: msg ?? '' })
  },

  appendLog(msg) {
    set((s) => ({ logs: [`${new Date().toLocaleTimeString()} — ${msg}`, ...s.logs].slice(0, 500) }))
  },

  reset() {
    set({
      status: 'idle',
      pipelinePhase: null,
      sessionId: null,
      totalCaptured: 0,
      duplicatesSkipped: 0,
      mapsTabId: null,
      lastMessage: '',
      logs: [],
    })
  },
}))
