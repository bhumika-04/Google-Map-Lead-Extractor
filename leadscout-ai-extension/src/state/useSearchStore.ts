import { create } from 'zustand'
import type { SearchSession } from '@/types/searchSession'
import { searchSessionRepository } from '@/db/searchSessionRepository'

interface SearchState {
  sessions: SearchSession[]
  activeSessionId: number | null
  loading: boolean
  loadSessions: () => Promise<void>
  setActiveSession: (id: number | null) => void
  addSession: (session: SearchSession) => void
  updateSession: (id: number, patch: Partial<SearchSession>) => void
}

export const useSearchStore = create<SearchState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loading: false,

  async loadSessions() {
    set({ loading: true })
    const sessions = await searchSessionRepository.getAll()
    set({ sessions, loading: false })
  },

  setActiveSession(id) {
    set({ activeSessionId: id })
  },

  addSession(session) {
    set((s) => ({ sessions: [session, ...s.sessions] }))
  },

  updateSession(id, patch) {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, ...patch } : sess
      ),
    }))
  },
}))
