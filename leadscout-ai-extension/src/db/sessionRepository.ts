import { db } from './db'
import type { SessionRecord, SessionStatus } from '@/types/session'
import { nowISO } from '@/utils/date'

// Repository for the redesigned `sessions` table (one row per scrape run or
// import batch). Replaces searchProjectRepository going forward.
export const sessionRepository = {
  async create(session: Omit<SessionRecord, 'id' | 'createdAt' | 'totalLeads'> & { totalLeads?: number }): Promise<number> {
    return db.sessions.add({
      ...session,
      totalLeads: session.totalLeads ?? 0,
      createdAt: nowISO(),
    } as SessionRecord)
  },

  async getById(id: number): Promise<SessionRecord | undefined> {
    return db.sessions.get(id)
  },

  async getAll(): Promise<SessionRecord[]> {
    return db.sessions.orderBy('createdAt').reverse().toArray()
  },

  async getBySource(source: SessionRecord['source']): Promise<SessionRecord[]> {
    return (await this.getAll()).filter((s) => s.source === source)
  },

  async update(id: number, patch: Partial<SessionRecord>): Promise<void> {
    await db.sessions.update(id, patch)
  },

  async setStatus(id: number, status: SessionStatus): Promise<void> {
    const patch: Partial<SessionRecord> = { status }
    if (status !== 'active' && status !== 'running') patch.completedAt = nowISO()
    await db.sessions.update(id, patch)
  },

  async addLeads(id: number, delta: number): Promise<void> {
    const s = await db.sessions.get(id)
    if (!s) return
    await db.sessions.update(id, { totalLeads: (s.totalLeads ?? 0) + delta })
  },

  // Deleting a session removes its leads too (matches the MSSQL ON DELETE CASCADE).
  async delete(id: number): Promise<void> {
    await db.transaction('rw', [db.sessions, db.scrapedLeads, db.importedLeads], async () => {
      await db.scrapedLeads.where('sessionId').equals(id).delete()
      await db.importedLeads.where('sessionId').equals(id).delete()
      await db.sessions.delete(id)
    })
  },
}
