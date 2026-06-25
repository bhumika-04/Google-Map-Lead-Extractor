import { create } from 'zustand'

export type CaptureStatus = 'idle' | 'opening_maps' | 'running' | 'stopped' | 'completed' | 'error'

interface CaptureState {
  status: CaptureStatus
  sessionId: number | null
  totalCaptured: number
  duplicatesSkipped: number
  mapsTabId: number | null
  lastMessage: string
  logs: string[]
  setStatus: (status: CaptureStatus) => void
  setSession: (sessionId: number) => void
  setMapsTabId: (tabId: number | null) => void
  updateProgress: (captured: number, dupes: number, msg?: string) => void
  appendLog: (msg: string) => void
  reset: () => void
}

export const useCaptureStore = create<CaptureState>((set) => ({
  status: 'idle',
  sessionId: null,
  totalCaptured: 0,
  duplicatesSkipped: 0,
  mapsTabId: null,
  lastMessage: '',
  logs: [],

  setStatus(status) {
    set({ status })
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
      sessionId: null,
      totalCaptured: 0,
      duplicatesSkipped: 0,
      mapsTabId: null,
      lastMessage: '',
      logs: [],
    })
  },
}))
