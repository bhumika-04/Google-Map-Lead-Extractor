import { db, type ActivityLog } from './db'
import { nowISO } from '@/utils/date'

export const activityLogRepository = {
  async log(
    type: string,
    message: string,
    sessionId?: number,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await db.activityLogs.add({ type, message, sessionId, metadata, createdAt: nowISO() })
  },

  async getAll(limit = 200): Promise<ActivityLog[]> {
    return db.activityLogs.orderBy('createdAt').reverse().limit(limit).toArray()
  },

  async getBySession(sessionId: number): Promise<ActivityLog[]> {
    return db.activityLogs
      .where('sessionId')
      .equals(sessionId)
      .reverse()
      .toArray()
  },

  async clear(): Promise<void> {
    await db.activityLogs.clear()
  },

  async count(): Promise<number> {
    return db.activityLogs.count()
  },
}
