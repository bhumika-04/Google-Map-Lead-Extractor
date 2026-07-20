import React, { useEffect, useState, useCallback } from 'react'
import Sidebar, { type NavSection } from './components/Sidebar'
import Topbar from './components/Topbar'
import SearchConsole from './components/SearchConsole'
import SearchSessionCards from './components/SearchSessionCards'
import ProgressCards from './components/ProgressCards'
import LeadTable from './components/LeadTable'
import ActivityLogPanel from './components/ActivityLogPanel'
import ToastContainer from './components/Toast'
import LeadDetailPanel from './components/LeadDetailPanel'
import AnalyticsSection from './components/AnalyticsSection'
import CsvImportSection from './components/CsvImportSection'
import SelectedCsvImport from './components/SelectedCsvImport'
import ExistingClientsSection from './components/ExistingClientsSection'
import BackupRestoreSection from './components/BackupRestoreSection'
import ResearchPage from './components/ResearchPage'
import CompanyIntelligencePage from './components/CompanyIntelligencePage'
import LinkedInIntelligencePage from './components/LinkedInIntelligencePage'
import MarketsPage from './components/MarketsPage'
import ValidationPanel from './components/ValidationPanel'
import BatchCampaignPanel from './components/BatchCampaignPanel'
import FollowUpPanel from './components/FollowUpPanel'
import NurturePanel from './components/NurturePanel'
import { useSettingsStore } from '@/state/useSettingsStore'
import { useSearchStore } from '@/state/useSearchStore'

import { useLeadStore } from '@/state/useLeadStore'
import { useCaptureStore } from '@/state/useCaptureStore'
import { toast } from '@/state/useToastStore'
import { MSG } from '@/types/messages'
import type { ProgressUpdatePayload } from '@/types/messages'
import { researchJobRepository } from '@/db/researchJobRepository'
import { searchEvidenceRepository } from '@/db/searchEvidenceRepository'
import { sourcePageRepository } from '@/db/sourcePageRepository'
import { searchSessionRepository } from '@/db/searchSessionRepository'
import { leadRepository } from '@/db/leadRepository'
import { existingClientRepository } from '@/db/existingClientRepository'
import { fetchExistingClients } from '@/services/sqlSyncService'
import StatusBadge from './components/StatusBadge'
import { timeAgo } from '@/utils/date'
import { activityLogRepository } from '@/db/activityLogRepository'

export default function Dashboard() {
  const [section, setSection] = useState<NavSection>('overview')
  const [researchCount, setResearchCount] = useState(0)
  // Total leads in IndexedDB — the sidebar badge. Deliberately NOT leads.length
  // from the store: that reflects whatever filter the current page loaded
  // (e.g. only 'selected' leads), which made the badge look like leads vanished
  // whenever the user switched pages.
  const [totalLeadCount, setTotalLeadCount] = useState(0)
  const refreshTotalLeadCount = useCallback(() => {
    leadRepository.getAll().then((all) => setTotalLeadCount(all.length)).catch(() => {})
  }, [])

  const { load: loadSettings, settings } = useSettingsStore()
  const { loadSessions } = useSearchStore()

  // Apply theme class to <html> whenever setting changes
  useEffect(() => {
    const html = document.documentElement
    if (settings.theme === 'light') {
      html.classList.add('light')
    } else {
      html.classList.remove('light')
    }
  }, [settings.theme])
  const { loadLeads, leads, closeDetail, detailLead } = useLeadStore()
  const { updateProgress, appendLog, setStatus, setPipelinePhase, status: captureStatus, totalCaptured: captureCaptured } = useCaptureStore()

  // Sidebar badge — refresh on mount and every 15s (captures/syncs change it)
  useEffect(() => {
    refreshTotalLeadCount()
    const badgeInterval = setInterval(refreshTotalLeadCount, 15000)
    return () => clearInterval(badgeInterval)
  }, [refreshTotalLeadCount])

  useEffect(() => {
    loadSettings()
    loadSessions()
    researchJobRepository.countPending().then(setResearchCount)

    // Pull the existing-clients block list down so the outreach hard-block check
    // works even if the user hasn't opened the "Existing Clients" page this session.
    fetchExistingClients().then((remote) => {
      if (remote.length === 0) return
      existingClientRepository.replaceAll(
        remote.map((r) => ({
          mssqlId: r.mssqlId,
          companyName: r.companyName,
          normalizedName: r.normalizedName,
          city: r.city,
          phone: r.phone,
          normalizedPhone: r.normalizedPhone,
          contactName: r.contactName,
          email: r.email,
          notes: r.notes,
          uploadedAt: r.uploadedAt,
        }))
      )
    }).catch(() => {})

    // MSSQL is the single source of truth — sync on every dashboard open.
    // If the database was cleared, this will clear local data too.
    chrome.runtime.sendMessage({ type: MSG.SYNC_FROM_DB })
      .then(() => loadLeads())
      .catch(() => loadLeads())  // If backend down, fall back to whatever is local

    chrome.runtime.sendMessage({ type: MSG.GET_STATUS })
      .then((res: any) => {
        if (res?.activeSession) {
          const s = res.activeSession
          updateProgress(s.totalCaptured, s.duplicatesSkipped, s.status)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (msg: any) => {
      if (msg.type !== MSG.PROGRESS_UPDATE) return
      const p = msg.payload as ProgressUpdatePayload
      updateProgress(p.totalCaptured, p.duplicatesSkipped, p.message)
      setStatus(p.status as any)
      if (p.pipelinePhase !== undefined) setPipelinePhase(p.pipelinePhase as any)
      appendLog(p.message ?? `Progress: ${p.totalCaptured} captured`)
      if (p.status === 'completed') {
        toast.success(`Capture complete — ${p.totalCaptured} leads captured`)
        loadLeads(); loadSessions()
      }
      if (p.status === 'stopped') {
        toast.warning(`Capture stopped — ${p.totalCaptured} leads saved`)
        loadLeads(); loadSessions()
      }
      if (p.status === 'running') loadLeads()
      researchJobRepository.countPending().then(setResearchCount)
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [updateProgress, appendLog, setStatus, loadLeads, loadSessions])

  // Close detail panel whenever section changes
  useEffect(() => {
    closeDetail()
  }, [section])

  // Global keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === '/' || e.key === 's') { e.preventDefault(); setSection('search') }
    if (e.key === 'l') setSection('leads')
    if (e.key === 'o') setSection('overview')
    if (e.key === 'Escape') closeDetail()
  }, [closeDetail])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      <Sidebar
        active={section}
        onChange={setSection}
        leadCount={totalLeadCount}
        researchCount={researchCount}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Topbar section={section} />

        <div className="flex-1 flex min-h-0 overflow-hidden">
          <main className="flex-1 overflow-auto p-5 flex flex-col min-h-0">
            {section === 'overview'  && <OverviewSection onNavigate={setSection} />}
            {section === 'search'    && (
              <div className="flex flex-col gap-5">
                <SearchConsole />
                <ProgressCards />
                <SearchSessionCards onNavigate={setSection} />
              </div>
            )}
            {section === 'leads'    && <LeadTable title="All Leads" />}
            {section === 'selected' && (
              <div className="flex flex-col flex-1 min-h-0 gap-5">
                <ValidationPanel />
                <SelectedCsvImport />
                <LeadTable title="Selected Leads" filterStatus="selected" />
              </div>
            )}
            {section === 'batch_campaigns'   && <BatchCampaignPanel />}
            {section === 'research'         && <ResearchQueueSection />}
            {section === 'research_results' && <ResearchPage />}
            {section === 'company_intelligence' && <CompanyIntelligencePage />}
            {section === 'linkedin_intelligence' && <LinkedInIntelligencePage />}
            {section === 'markets' && <MarketsPage onNavigate={setSection} />}
            {section === 'followups'  && <FollowUpPanel />}
            {section === 'nurture'    && <NurturePanel />}
            {section === 'analytics'  && <AnalyticsSection />}
            {section === 'import'     && <CsvImportSection />}
            {section === 'existing_clients' && <ExistingClientsSection />}
            {section === 'backup'     && <BackupRestoreSection />}
            {section === 'logs'       && <ActivityLogPanel />}
          </main>

          <LeadDetailPanel />
        </div>
      </div>

      <ToastContainer />
    </div>
  )
}

// ─── Overview Section ─────────────────────────────────────────────────────────

function OverviewSection({ onNavigate }: { onNavigate: (s: NavSection) => void }) {
  const { sessions, loadSessions } = useSearchStore()
  const { leads, loadLeads } = useLeadStore()
  useCaptureStore()

  const newLeads      = leads.filter((l) => l.status === 'new').length
  const selectedLeads = leads.filter((l) => l.status === 'selected').length
  const rejectedLeads = leads.filter((l) => l.status === 'rejected').length
  const researchLeads = leads.filter((l) => l.status.startsWith('research')).length
  const totalLeads    = leads.length

  const maxSessionLeads = sessions.reduce((m, s) => Math.max(m, s.totalCaptured), 1)

  async function handleDeleteSession(id: number) {
    if (!confirm('Delete this session and all its leads?')) return
    await leadRepository.deleteBySession(id)
    await searchSessionRepository.delete(id)
    await loadSessions()
    await loadLeads()
    toast.success('Session deleted')
  }

  return (
    <div className="space-y-5">
      <ProgressCards />

      {/* Lead status breakdown */}
      {totalLeads > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">Lead Breakdown</h3>
            <span className="text-xs text-gray-500">{totalLeads} total leads</span>
          </div>
          <div className="flex gap-3 flex-wrap mb-3">
            {[
              { label: 'New',      count: newLeads,      color: 'bg-blue-500' },
              { label: 'Selected', count: selectedLeads, color: 'bg-green-500' },
              { label: 'Rejected', count: rejectedLeads, color: 'bg-red-500' },
              { label: 'Research', count: researchLeads, color: 'bg-purple-500' },
            ].map(({ label, count, color }) => (
              <div key={label} className="flex items-center gap-2 text-xs text-gray-300">
                <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
                <span className="font-medium text-white">{count}</span>
                <span className="text-gray-500">{label}</span>
              </div>
            ))}
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden flex">
            {newLeads > 0      && <div className="bg-blue-500   h-full transition-all" style={{ width: `${newLeads/totalLeads*100}%` }} />}
            {selectedLeads > 0 && <div className="bg-green-500  h-full transition-all" style={{ width: `${selectedLeads/totalLeads*100}%` }} />}
            {rejectedLeads > 0 && <div className="bg-red-500    h-full transition-all" style={{ width: `${rejectedLeads/totalLeads*100}%` }} />}
            {researchLeads > 0 && <div className="bg-purple-500 h-full transition-all" style={{ width: `${researchLeads/totalLeads*100}%` }} />}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Quick actions */}
        <div className="col-span-1 bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
          <h3 className="text-sm font-semibold text-white mb-3">Quick Actions</h3>
          <QuickAction icon="⌕" label="New Search" onClick={() => onNavigate('search')} primary />
          <QuickAction icon="⊞" label="Batch Campaigns" onClick={() => onNavigate('batch_campaigns')} />
          <QuickAction icon="☰" label={`View All Leads (${leads.length})`} onClick={() => onNavigate('leads')} />
          <QuickAction icon="✓" label={`Selected (${selectedLeads})`} onClick={() => onNavigate('selected')} />
          <QuickAction icon="⚗" label="Research Queue" onClick={() => onNavigate('research')} />
          <QuickAction icon="⏰" label="Follow-Ups" onClick={() => onNavigate('followups')} />
          <QuickAction icon="◎" label="Nurture Sequences" onClick={() => onNavigate('nurture')} />
          {/* Keyboard hint */}
          <div className="pt-2 border-t border-gray-800 text-xs text-gray-700 space-y-0.5">
            <div><kbd className="bg-gray-800 px-1 rounded text-gray-600">/</kbd> Search &nbsp; <kbd className="bg-gray-800 px-1 rounded text-gray-600">l</kbd> Leads &nbsp; <kbd className="bg-gray-800 px-1 rounded text-gray-600">o</kbd> Overview</div>
          </div>
        </div>

        {/* Recent sessions */}
        <div className="col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">Recent Sessions</h3>
            <span className="text-xs text-gray-600">{sessions.length} total</span>
          </div>
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-gray-700">
              <div className="text-4xl mb-2">⌕</div>
              <div className="text-sm text-gray-500">No sessions yet</div>
              <button onClick={() => onNavigate('search')} className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                Start your first search →
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.slice(0, 8).map((s) => (
                <div key={s.id} className="group">
                  <div className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <StatusBadge status={s.status} size="xs" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-white text-xs font-medium">{s.keyword}</span>
                        <span className="text-gray-600 text-xs">in</span>
                        <span className="text-gray-400 text-xs">{s.city}</span>
                      </div>
                      {/* Per-session bar */}
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600/70 rounded-full transition-all"
                            style={{ width: `${Math.round((s.totalCaptured / maxSessionLeads) * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-green-400 font-semibold shrink-0 w-8 text-right">{s.totalCaptured}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      {s.duplicatesSkipped > 0 && (
                        <span className="text-yellow-700">{s.duplicatesSkipped} dupes</span>
                      )}
                      <span className="text-gray-700">{timeAgo(s.createdAt)}</span>
                      <button
                        onClick={() => handleDeleteSession(s.id!)}
                        className="opacity-0 group-hover:opacity-100 text-gray-700 hover:text-red-400 transition-all text-base leading-none"
                        title="Delete session"
                      >×</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function QuickAction({ icon, label, onClick, primary }: { icon: string; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
        primary
          ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
          : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
      }`}
    >
      <span className="text-base w-5 text-center shrink-0">{icon}</span>
      {label}
    </button>
  )
}

// ─── Research Queue Section ───────────────────────────────────────────────────

function ResearchQueueSection() {
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof researchJobRepository.getAll>>>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [apiKeySource, setApiKeySource] = useState<'extension' | 'backend' | 'none'>('none')
  const { settings, load: loadSettings, loaded } = useSettingsStore()

  useEffect(() => { if (!loaded) loadSettings() }, [loaded, loadSettings])

  // Check if any API key is available (settings already merged backend keys on load)
  useEffect(() => {
    if (!loaded) return
    const hasKey = settings.researchProvider === 'gemini' ? !!settings.geminiApiKey
      : settings.researchProvider === 'openai' ? !!settings.openAiApiKey
      : !!settings.anthropicApiKey
    setApiKeySource(hasKey ? 'backend' : 'none')
  }, [loaded, settings.geminiApiKey, settings.openAiApiKey, settings.anthropicApiKey, settings.researchProvider])

  async function refreshJobs() {
    const j = await researchJobRepository.getAll()
    setJobs(j)
    setLoading(false)
  }

  useEffect(() => {
    refreshJobs()
    const interval = setInterval(refreshJobs, 3000)
    return () => clearInterval(interval)
  }, [])

  // While a job is running, poll its evidence/source-page progress: current
  // search query, the source currently being opened, and completed/failed counts.
  const [activity, setActivity] = useState<{
    companyName: string
    query?: string
    currentSourceUrl?: string
    completed: number
    failed: number
  } | null>(null)

  useEffect(() => {
    const runningJob = jobs.find((j) => j.status === 'running')
    if (!runningJob) { setActivity(null); return }

    let cancelled = false
    async function poll() {
      const [evidenceRows, pages] = await Promise.all([
        searchEvidenceRepository.getByLeadId(runningJob.leadId),
        sourcePageRepository.getByLeadId(runningJob.leadId),
      ])
      if (cancelled) return
      const current = pages.find((p) => p.status === 'pending')
      setActivity({
        companyName: runningJob.companyName,
        query: evidenceRows[0]?.query,
        currentSourceUrl: current?.url,
        completed: pages.filter((p) => p.status === 'extracted').length,
        failed: pages.filter((p) => p.status === 'failed').length,
      })
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [jobs])

  async function handleRunNow() {
    if (apiKeySource === 'none') {
      toast.error('No API key found — add it in Settings or ensure the DeepLead API is running')
      return
    }

    setRunning(true)
    try {
      const res: any = await chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH })
      if (res?.ok === false && res?.reason === 'no_api_key') {
        toast.error(`API key missing — add ${res.provider} key to appsettings.json and restart backend`)
      } else {
        toast.success('Research started — status updates every 3 seconds')
        setTimeout(refreshJobs, 1500)
      }
    } catch {
      toast.error('Could not trigger research — reload the extension first')
    } finally {
      setRunning(false)
    }
  }

  async function handleCancel(id: number) {
    await researchJobRepository.updateStatus(id, 'cancelled')
    setJobs((prev) => prev.map((j) => j.id === id ? { ...j, status: 'cancelled' as const } : j))
    toast.info('Research job cancelled')
  }

  async function handleRetry(job: (typeof jobs)[0]) {
    await researchJobRepository.updateStatus(job.id!, 'pending', { errorMessage: undefined, startedAt: undefined })
    const lead = await leadRepository.getById(job.leadId).catch(() => null)
    if (lead?.id) await leadRepository.updateStatus(lead.id, 'research_pending')
    await refreshJobs()
    toast.success(`${job.companyName} re-queued`)
  }

  async function handleDelete(id: number) {
    await researchJobRepository.delete(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
    toast.success('Job removed from queue')
  }

  async function handleExportQueue() {
    const data = jobs.map(({ id: _id, ...j }) => j)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `research-queue-${Date.now()}.json`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
    toast.success(`Exported ${jobs.length} research jobs`)
    await activityLogRepository.log('export_completed', `Research queue exported (${jobs.length} jobs)`)
  }

  const pendingCount   = jobs.filter((j) => j.status === 'pending').length
  const runningCount   = jobs.filter((j) => j.status === 'running').length
  const completedCount = jobs.filter((j) => j.status === 'completed').length
  const failedCount    = jobs.filter((j) => j.status === 'failed').length
  const hasKey = settings.researchProvider === 'gemini' ? !!settings.geminiApiKey
    : settings.researchProvider === 'openai' ? !!settings.openAiApiKey
    : !!settings.anthropicApiKey

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">

      {/* API key status banner */}
      {loaded && apiKeySource === 'none' && (
        <div className="flex items-center gap-3 bg-yellow-950/60 border border-yellow-800/60 rounded-xl px-4 py-3">
          <span className="text-yellow-400 text-lg shrink-0">⚠</span>
          <div className="text-xs text-yellow-300">
            <span className="font-semibold">No API key found.</span> Add your Gemini / OpenAI key to <span className="font-mono">DeepLeadApi/appsettings.json</span> and restart the backend.
          </div>
        </div>
      )}
      {loaded && apiKeySource === 'backend' && (
        <div className="flex items-center gap-3 bg-green-950/40 border border-green-800/40 rounded-xl px-4 py-3">
          <span className="text-green-400 shrink-0">✓</span>
          <div className="text-xs text-green-300">
            <span className="font-semibold">API key loaded from local DeepLead API.</span>
            <span className="text-green-600 ml-1">No manual entry needed — key is stored in the backend.</span>
          </div>
        </div>
      )}

      {/* Live research indicator */}
      {runningCount > 0 && (
        <div className="flex flex-col gap-1.5 bg-purple-950/60 border border-purple-700/60 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3 animate-pulse">
            <span className="text-purple-400 text-lg shrink-0">⚗</span>
            <div className="text-xs text-purple-300">
              <span className="font-semibold">Evidence research in progress{activity ? `: ${activity.companyName}` : '…'}</span>
            </div>
          </div>
          {activity && (
            <div className="pl-8 text-xs text-purple-400 space-y-0.5">
              {activity.query && <div>Search query: <span className="text-purple-300">"{activity.query}"</span></div>}
              {activity.currentSourceUrl && <div>Opening: <span className="text-purple-300 break-all">{activity.currentSourceUrl}</span></div>}
              <div>Sources visited: <span className="text-green-400">{activity.completed} completed</span>{activity.failed > 0 && <span className="text-red-400 ml-2">{activity.failed} failed</span>}</div>
            </div>
          )}
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Pending',   value: pendingCount,   color: 'text-yellow-400' },
          { label: 'Running',   value: runningCount,   color: runningCount > 0 ? 'text-purple-400 animate-pulse' : 'text-gray-600' },
          { label: 'Completed', value: completedCount, color: 'text-green-400' },
          { label: 'Failed',    value: failedCount,    color: failedCount > 0 ? 'text-red-400' : 'text-gray-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className={`text-xl font-bold ${color}`}>{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Job list */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Queued Jobs</h3>
        <div className="flex gap-2">
          {pendingCount > 0 && (
            <button
              onClick={handleRunNow}
              disabled={running}
              className="text-xs px-3 py-1.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg transition-colors font-medium"
            >
              {running ? 'Running…' : '▶ Run Now'}
            </button>
          )}
          {jobs.length > 0 && (
            <button onClick={handleExportQueue} className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors">
              Export JSON
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2">
            {[1,2,3].map((i) => (
              <div key={i} className="h-16 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-700 bg-gray-900 border border-gray-800 rounded-xl">
            <div className="text-4xl mb-2 opacity-30">⚗</div>
            <div className="text-sm text-gray-500">Queue is empty</div>
            <div className="text-xs mt-1 text-gray-700">Select leads → click ⚗ to add to research queue</div>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div key={job.id} className={`bg-gray-900 border rounded-xl px-4 py-3 hover:border-gray-700 transition-colors group ${
                job.status === 'failed' ? 'border-red-900/60' :
                job.status === 'running' ? 'border-purple-700/60' : 'border-gray-800'
              }`}>
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{job.companyName}</div>
                    <div className="text-xs text-gray-500 mt-0.5 capitalize">
                      {job.status === 'running'
                        ? <span className="text-purple-400 animate-pulse">⚗ Researching — fetching website &amp; calling AI…</span>
                        : job.jobType.replace(/_/g, ' ')}
                    </div>
                  </div>
                  <StatusBadge status={job.status} size="xs" />
                  <span className="text-xs text-gray-700">{timeAgo(job.createdAt)}</span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {job.status === 'pending' && (
                      <button onClick={() => handleCancel(job.id!)} className="text-xs px-2 py-1 bg-gray-800 hover:bg-yellow-900 text-gray-400 hover:text-yellow-300 rounded transition-colors">
                        Cancel
                      </button>
                    )}
                    {job.status === 'failed' && (
                      <button onClick={() => handleRetry(job)} className="text-xs px-2 py-1 bg-purple-900 hover:bg-purple-800 text-purple-300 rounded transition-colors">
                        Retry
                      </button>
                    )}
                    <button onClick={() => handleDelete(job.id!)} className="text-xs px-2 py-1 bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 rounded transition-colors">
                      Remove
                    </button>
                  </div>
                </div>
                {job.status === 'failed' && job.errorMessage && (
                  <div className="mt-1.5 text-xs text-red-600 bg-red-950/30 rounded px-2 py-1">{job.errorMessage}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
