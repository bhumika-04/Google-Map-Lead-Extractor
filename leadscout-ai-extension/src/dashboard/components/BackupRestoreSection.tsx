import React, { useRef, useState, useEffect } from 'react'
import { db } from '@/db/db'
import { toast } from '@/state/useToastStore'
import { nowISO } from '@/utils/date'
import { clearAllLocalData } from '@/services/backupSyncService'
import { restoreFromSql, isApiAvailable } from '@/services/sqlSyncService'

const API = 'http://localhost:5150'

interface BackupData {
  version: number
  exportedAt: string
  leads: any[]
  searchSessions: any[]
  researchJobs: any[]
  researchResults: any[]
  settings: any[]
}

export default function BackupRestoreSection() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [syncing, setSyncing]       = useState(false)
  const [clearing, setClearing]     = useState(false)
  const [importing, setImporting]   = useState(false)
  const [exporting, setExporting]   = useState(false)
  const [apiUp, setApiUp]           = useState<boolean | null>(null)
  const [counts, setCounts]         = useState({ leads: 0, results: 0, jobs: 0 })

  async function refreshCounts() {
    const [leads, results, jobs] = await Promise.all([
      db.leads.count(),
      db.researchResults.count(),
      db.researchJobs.count(),
    ])
    setCounts({ leads, results, jobs })
  }

  useEffect(() => {
    refreshCounts()
    isApiAvailable().then(setApiUp)
  }, [])

  // ── Sync from Database (MSSQL → IndexedDB) ─────────────────────────────────
  async function handleSyncFromDb() {
    setSyncing(true)
    try {
      const ok = await isApiAvailable()
      if (!ok) { toast.error('Backend not reachable at localhost:5150'); return }

      const data = await restoreFromSql()
      if (!data) { toast.error('Could not fetch data from MSSQL'); return }

      const companies = data.companies ?? []

      if (companies.length === 0) {
        // MSSQL is empty — this would wipe local data to match. Same destructive
        // action as "Clear All Local Data" below, so it needs the same confirmation
        // (previously this ran with zero warning — the cause of a real data-loss incident).
        const localCount = await db.leads.count()
        const ok = confirm(
          `MSSQL returned 0 companies, but you have ${localCount} leads stored locally.\n\n` +
          `Continuing will DELETE all ${localCount} local leads and research data to match the empty database.\n\n` +
          `This cannot be undone. Continue?`
        )
        if (!ok) { toast.info('Sync cancelled — local data unchanged'); return }
        await clearAllLocalData()
        await refreshCounts()
        toast.success('MSSQL is empty — local data cleared to match')
        return
      }

      // Rebuild IndexedDB from MSSQL companies
      // First clear existing leads so deleted records are removed too
      await db.transaction('rw', [db.leads, db.searchSessions], async () => {
        await db.leads.clear()
        await db.searchSessions.clear()

        for (const c of companies) {
          await db.leads.add({
            companyName:    c.companyName,
            normalizedName: (c.companyName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80),
            address:        c.address,
            phone:          c.phone,
            website:        c.website,
            googleMapsUrl:  c.googleMapsUrl,
            rating:         c.rating,
            reviewCount:    c.reviewCount,
            category:       c.category,
            city:           c.city ?? '',
            keyword:        c.keyword ?? '',
            searchQuery:    c.sessionName ?? '',
            source:         'sql_restore',
            status:         'new' as const,
            confidence:     0.8,
            capturedAt:     c.sessionCreatedAt ?? nowISO(),
            updatedAt:      nowISO(),
            sessionId:      0,
          })
        }
      })

      await refreshCounts()
      toast.success(`Synced ${companies.length} leads from MSSQL — reload the page to see them`)
    } catch (err: any) {
      toast.error(`Sync failed: ${err?.message}`)
    } finally {
      setSyncing(false)
    }
  }

  // ── Clear all local data ────────────────────────────────────────────────────
  async function handleClearAll() {
    if (!confirm('This will delete ALL local leads and research data. The MSSQL database is NOT affected. Continue?')) return
    setClearing(true)
    try {
      await clearAllLocalData()
      await refreshCounts()
      toast.success('All local data cleared — reload the page')
    } catch (err: any) {
      toast.error(`Clear failed: ${err?.message}`)
    } finally {
      setClearing(false)
    }
  }

  // ── Export backup (JSON download) ───────────────────────────────────────────
  async function handleExport() {
    setExporting(true)
    try {
      const [leads, searchSessions, researchJobs, researchResults, settings] = await Promise.all([
        db.leads.toArray(),
        db.searchSessions.toArray(),
        db.researchJobs.toArray(),
        db.researchResults.toArray(),
        db.settings.toArray(),
      ])

      const backup: BackupData = {
        version: 1, exportedAt: nowISO(),
        leads, searchSessions, researchJobs, researchResults, settings,
      }

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url
      a.download = `leadscout-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast.success(`Exported ${leads.length} leads`)
    } catch (err: any) {
      toast.error(`Export failed: ${err?.message}`)
    } finally {
      setExporting(false)
    }
  }

  // ── Import from JSON file ───────────────────────────────────────────────────
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImporting(true)
    try {
      const backup = JSON.parse(await file.text()) as BackupData
      if (!backup.leads || !Array.isArray(backup.leads)) throw new Error('Invalid backup file')

      await db.transaction('rw', [db.leads, db.searchSessions, db.researchJobs, db.researchResults, db.settings], async () => {
        if (backup.leads?.length)           await db.leads.bulkPut(backup.leads)
        if (backup.searchSessions?.length)  await db.searchSessions.bulkPut(backup.searchSessions)
        if (backup.researchJobs?.length)    await db.researchJobs.bulkPut(backup.researchJobs)
        if (backup.researchResults?.length) await db.researchResults.bulkPut(backup.researchResults)
        if (backup.settings?.length)        await db.settings.bulkPut(backup.settings)
      })

      await refreshCounts()
      toast.success(`Restored ${backup.leads.length} leads — reload the page`)
    } catch (err: any) {
      toast.error(`Import failed: ${err?.message}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">

      {/* API status banner */}
      {apiUp === false && (
        <div className="bg-red-950/40 border border-red-800/50 rounded-xl px-4 py-3 text-xs text-red-300">
          Backend not reachable at <code>localhost:5150</code> — start the DeepLead API first.
        </div>
      )}

      {/* Local counts */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">Local Cache (IndexedDB)</h3>
        <div className="grid grid-cols-3 gap-3 text-center text-xs text-gray-500">
          <div className="bg-gray-800 rounded-lg px-3 py-2.5">
            <div className="text-lg font-bold text-white">{counts.leads}</div>
            <div className="mt-0.5">Leads</div>
          </div>
          <div className="bg-gray-800 rounded-lg px-3 py-2.5">
            <div className="text-lg font-bold text-white">{counts.results}</div>
            <div className="mt-0.5">Research Results</div>
          </div>
          <div className="bg-gray-800 rounded-lg px-3 py-2.5">
            <div className="text-lg font-bold text-white">{counts.jobs}</div>
            <div className="mt-0.5">Research Jobs</div>
          </div>
        </div>
      </div>

      {/* Sync + Clear — side by side to fill the width */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
      {/* Sync from Database — primary action */}
      <div className="bg-gray-900 border border-blue-800/40 rounded-xl p-5 space-y-3 flex flex-col">
        <div>
          <h3 className="text-sm font-semibold text-white">Sync from Database</h3>
          <p className="text-xs text-gray-500 mt-1">
            Pulls the current state of MSSQL and rebuilds local data to match.
            If MSSQL is empty, local data is cleared too.
            <span className="text-blue-400"> MSSQL is the source of truth.</span>
          </p>
        </div>
        <button
          onClick={handleSyncFromDb}
          disabled={syncing || apiUp === false}
          className="w-full mt-auto py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50
            text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {syncing ? 'Syncing…' : '⟳ Sync from MSSQL Database'}
        </button>
      </div>

      {/* Clear local data */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3 flex flex-col">
        <div>
          <h3 className="text-sm font-semibold text-white">Clear Local Data</h3>
          <p className="text-xs text-gray-500 mt-1">
            Wipes all leads and research data from the local browser cache.
            Does not affect MSSQL — use this after clearing the database to sync the extension.
          </p>
        </div>
        <button
          onClick={handleClearAll}
          disabled={clearing}
          className="w-full mt-auto py-2.5 bg-red-900/50 hover:bg-red-800 disabled:opacity-50
            text-red-300 hover:text-white text-sm font-semibold rounded-lg transition-colors border border-red-800/50"
        >
          {clearing ? 'Clearing…' : '✕ Clear All Local Data'}
        </button>
      </div>
      </div>

      {/* Export / Import */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">JSON Backup (Manual)</h3>
        <p className="text-xs text-gray-500">
          Export a local JSON snapshot or restore one. Used for transferring data between machines.
        </p>
        <div className="flex gap-3">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50
              text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {exporting ? 'Exporting…' : '↓ Export JSON'}
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50
              text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {importing ? 'Importing…' : '↑ Import JSON'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
      </div>

    </div>
  )
}
