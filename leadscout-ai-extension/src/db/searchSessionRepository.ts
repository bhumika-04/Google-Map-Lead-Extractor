import { db } from './db'
import type { SearchSession, SessionStatus } from '@/types/searchSession'
import { nowISO } from '@/utils/date'

export const searchSessionRepository = {
  async create(data: Omit<SearchSession, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const now = nowISO()
    return db.searchSessions.add({ ...data, createdAt: now, updatedAt: now })
  },

  async getById(id: number): Promise<SearchSession | undefined> {
    return db.searchSessions.get(id)
  },

  async getAll(): Promise<SearchSession[]> {
    return db.searchSessions.orderBy('createdAt').reverse().toArray()
  },

  async updateStatus(id: number, status: SessionStatus, extra?: Partial<SearchSession>): Promise<void> {
    await db.searchSessions.update(id, { status, updatedAt: nowISO(), ...extra })
  },

  async incrementCaptured(id: number): Promise<void> {
    const session = await db.searchSessions.get(id)
    if (!session) return
    await db.searchSessions.update(id, {
      totalCaptured: (session.totalCaptured ?? 0) + 1,
      updatedAt: nowISO(),
    })
  },

  async incrementDuplicates(id: number): Promise<void> {
    const session = await db.searchSessions.get(id)
    if (!session) return
    await db.searchSessions.update(id, {
      duplicatesSkipped: (session.duplicatesSkipped ?? 0) + 1,
      updatedAt: nowISO(),
    })
  },

  async complete(id: number, totalCaptured: number): Promise<void> {
    const now = nowISO()
    await db.searchSessions.update(id, {
      status: 'completed',
      totalCaptured,
      completedAt: now,
      updatedAt: now,
    })
  },

  async delete(id: number): Promise<void> {
    await db.searchSessions.delete(id)
  },
}
