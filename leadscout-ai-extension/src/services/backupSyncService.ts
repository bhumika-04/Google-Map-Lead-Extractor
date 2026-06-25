import { db } from '@/db/db'
import { nowISO } from '@/utils/date'

const API = 'http://localhost:5150'
const TIMEOUT_MS = 5000

async function isBackendAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

// Push full IndexedDB state to backend — called after every significant write
export async function pushBackup(): Promise<void> {
  try {
    const available = await isBackendAvailable()
    if (!available) return

    const [leads, searchSessions, researchJobs, researchResults, settings] = await Promise.all([
      db.leads.toArray(),
      db.searchSessions.toArray(),
      db.researchJobs.toArray(),
      db.researchResults.toArray(),
      db.settings.toArray(),
    ])

    await fetch(`${API}/api/extension-backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        exportedAt: nowISO(),
        leads,
        searchSessions,
        researchJobs,
        researchResults,
        settings,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Sync is best-effort — never block the main flow
  }
}

// Wipe all local IndexedDB data — used when user clears MSSQL and wants extension to match.
export async function clearAllLocalData(): Promise<void> {
  await db.transaction('rw', [
    db.leads, db.searchSessions, db.researchJobs, db.researchResults,
  ], async () => {
    await db.leads.clear()
    await db.searchSessions.clear()
    await db.researchJobs.clear()
    await db.researchResults.clear()
  })
  // Also wipe the JSON backup file so reinstalling doesn't restore stale data
  try {
    await fetch(`${API}/api/extension-backup`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    })
  } catch {}
}

// Pull backup from backend and restore into IndexedDB (ONLY as a last resort fallback).
// Not called automatically — kept for manual use only.
export async function restoreFromBackupIfEmpty(): Promise<boolean> {
  try {
    const leadCount = await db.leads.count()
    if (leadCount > 0) return false  // DB has data — no restore needed

    const available = await isBackendAvailable()
    if (!available) return false

    const r = await fetch(`${API}/api/extension-backup`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!r.ok) return false

    const json = await r.json()
    if (!json?.ok || !json?.data) return false

    const backup = json.data
    if (!backup.leads?.length) return false

    await db.transaction('rw', [
      db.leads, db.searchSessions, db.researchJobs, db.researchResults, db.settings,
    ], async () => {
      if (backup.leads?.length)           await db.leads.bulkPut(backup.leads)
      if (backup.searchSessions?.length)  await db.searchSessions.bulkPut(backup.searchSessions)
      if (backup.researchJobs?.length)    await db.researchJobs.bulkPut(backup.researchJobs)
      if (backup.researchResults?.length) await db.researchResults.bulkPut(backup.researchResults)
      if (backup.settings?.length)        await db.settings.bulkPut(backup.settings)
    })

    return true
  } catch {
    return false
  }
}
