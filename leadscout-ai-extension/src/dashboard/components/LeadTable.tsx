import React, { useEffect, useState, useRef } from 'react'
import type { Lead, LeadStatus, LeadFilter } from '@/types/lead'
import { useLeadStore } from '@/state/useLeadStore'
import { useSearchStore } from '@/state/useSearchStore'
import { addToResearchQueue } from '@/services/futureResearchService'
import { exportToJSON, exportToDoc } from '@/services/exportService'
import { exportRowsToCSV, type ExportRowInput } from '@/utils/csvExport'
import { researchResultRepository } from '@/db/researchResultRepository'
import { leadRepository } from '@/db/leadRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import { toast } from '@/state/useToastStore'
import { calculateLeadScore } from '@/utils/leadScore'
import { pushBatchToCrm, pushLeadToCrm } from '@/services/crmService'
import { useSettingsStore } from '@/state/useSettingsStore'
import { runPreValidationEnrichment } from '@/services/preValidationEnrichmentService'
import { resolveAiCredentials } from '@/services/sqlSyncService'
import StatusBadge from './StatusBadge'
import ScoreBadge from './ScoreBadge'
import CopyBtn from './CopyBtn'
import { formatDateTime } from '@/utils/date'

interface LeadTableProps {
  filterStatus?: LeadStatus
  title?: string
}

type SortKey = 'score' | 'icpScore' | 'capturedAt' | 'rating' | 'companyName'
type SortDir = 'asc' | 'desc'

const ALL_COLUMNS = ['icpScore', 'score', 'teamSize', 'turnover', 'category', 'rating', 'phone', 'website', 'status', 'date'] as const
type ColKey = typeof ALL_COLUMNS[number]
const COL_LABELS: Record<ColKey, string> = {
  icpScore: 'ICP Score', score: 'Map Score', teamSize: 'Team Size', turnover: 'Turnover',
  category: 'Category', rating: 'Rating',
  phone: 'Phone', website: 'Website', status: 'Status', date: 'Date',
}

// Per-view column storage: Selected Leads shows ICP Score by default, Lead Database does not
function colKey(filterStatus?: string) {
  return filterStatus === 'selected' ? 'lt_visible_cols_selected_v1' : 'lt_visible_cols_leads_v1'
}
function loadCols(filterStatus?: string): Set<ColKey> {
  try {
    const saved = localStorage.getItem(colKey(filterStatus))
    if (saved) return new Set(JSON.parse(saved) as ColKey[])
  } catch {}
  if (filterStatus === 'selected') {
    // Selected Leads: ICP Score prominent, all enrichment columns
    return new Set(['icpScore', 'score', 'teamSize', 'turnover', 'category', 'rating', 'phone', 'status', 'date'] as ColKey[])
  }
  // Lead Database: no ICP Score by default (new leads don't have it yet)
  return new Set(['score', 'teamSize', 'turnover', 'category', 'rating', 'phone', 'status', 'date'] as ColKey[])
}
function saveCols(cols: Set<ColKey>, filterStatus?: string) {
  localStorage.setItem(colKey(filterStatus), JSON.stringify([...cols]))
}

export default function LeadTable({ filterStatus, title }: LeadTableProps) {
  const {
    leads, selectedIds, loading, marketScope, projectScope,
    loadLeads, updateLeadStatus, toggleSelect, selectAll, clearSelection, openDetail, setMarketScope, setProjectScope,
  } = useLeadStore()
  const { sessions } = useSearchStore()
  const { settings } = useSettingsStore()

  const [sessionFilter, setSessionFilter] = useState<number | ''>('')
  const [search, setSearch]   = useState('')
  const [minRating, setMinRating] = useState<number>(0)
  const [minIcpScore, setMinIcpScore] = useState<number>(0)
  const [hasPhone, setHasPhone]     = useState<boolean | null>(null)
  const [hasWebsite, setHasWebsite] = useState<boolean | null>(null)
  const [hasTeamSize, setHasTeamSize] = useState<boolean | null>(null)
  const [hasTurnover, setHasTurnover] = useState<boolean | null>(null)
  const [hideNotRelevant, setHideNotRelevant] = useState(false)
  const [reEnriching, setReEnriching] = useState(false)
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('capturedAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [compact, setCompact]       = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [showCols, setShowCols]       = useState(false)
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(() => loadCols(filterStatus))
  const [page, setPage] = useState(1)

  // Undo delete: map id → { lead, timer }
  const pendingDeletes = useRef<Map<number, { lead: Lead; timer: ReturnType<typeof setTimeout> }>>(new Map())
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  const PER_PAGE = 50

  useEffect(() => {
    const filter: LeadFilter = {}
    if (filterStatus === 'selected') {
      // Show all leads that were ever selected — including those that progressed to research stages
      filter.statuses = ['selected', 'research_pending', 'research_running', 'research_completed', 'research_failed']
    } else if (filterStatus) {
      filter.status = filterStatus
    }
    if (sessionFilter !== '') filter.sessionId = sessionFilter as number
    if (minRating > 0) filter.minRating = minRating
    if (hasPhone !== null) filter.hasPhone = hasPhone
    if (hasWebsite !== null) filter.hasWebsite = hasWebsite
    if (hideNotRelevant && !filterStatus) filter.hideNotRelevant = true
    // Market scope from the Markets page — country/city drill-down
    if (marketScope) {
      filter.country = marketScope.country
      if (marketScope.city) filter.city = marketScope.city
    }
    // Global Search Session scope from the Topbar switcher / session cards
    if (projectScope) filter.projectId = projectScope.id
    loadLeads(filter)
    setPage(1)
  }, [filterStatus, sessionFilter, minRating, hasPhone, hasWebsite, hideNotRelevant, marketScope, projectScope])

  function toggleCol(col: ColKey) {
    setVisibleCols((prev) => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      saveCols(next, filterStatus)
      return next
    })
  }

  function col(key: ColKey) { return visibleCols.has(key) }

  const activeFilterCount = [minRating > 0, minIcpScore > 0, hasPhone !== null, hasWebsite !== null, hasTeamSize !== null, hasTurnover !== null, sessionFilter !== '', hideNotRelevant].filter(Boolean).length

  // Text search + client-side filters
  const textFiltered = leads.filter((l) => {
    if (search) {
      const q = search.toLowerCase()
      const matches = (
        l.companyName.toLowerCase().includes(q) ||
        (l.city?.toLowerCase().includes(q) ?? false) ||
        (l.category?.toLowerCase().includes(q) ?? false) ||
        (l.phone?.includes(q) ?? false)
      )
      if (!matches) return false
    }
    if (minIcpScore > 0 && (l.icpScore ?? -1) < minIcpScore) return false
    if (hasTeamSize === true  && !l.teamSize)       return false
    if (hasTeamSize === false &&  l.teamSize)        return false
    if (hasTurnover === true  && !l.annualTurnover)  return false
    if (hasTurnover === false &&  l.annualTurnover)  return false
    return true
  })

  // Sort
  const sorted = [...textFiltered].sort((a, b) => {
    let cmp = 0
    if (sortKey === 'score')        cmp = calculateLeadScore(a) - calculateLeadScore(b)
    else if (sortKey === 'icpScore') cmp = (a.icpScore ?? -1) - (b.icpScore ?? -1)
    else if (sortKey === 'rating')   cmp = (a.rating ?? 0) - (b.rating ?? 0)
    else if (sortKey === 'companyName') cmp = a.companyName.localeCompare(b.companyName)
    else cmp = a.capturedAt.localeCompare(b.capturedAt)
    return sortDir === 'asc' ? cmp : -cmp
  })

  const totalPages = Math.ceil(sorted.length / PER_PAGE)
  const paginated  = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const selectedCount = selectedIds.size

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return <span className="text-gray-700 ml-0.5">↕</span>
    return <span className="text-blue-400 ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  function exportFilename(ext: string) {
    const base = sessionFilter !== ''
      ? sessions.find((s) => s.id === sessionFilter)?.keyword ?? 'leads'
      : filterStatus ?? 'leads'
    return `leadscout-${base.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.${ext}`
  }

  async function handleStatusChange(lead: Lead, status: LeadStatus, e: React.MouseEvent) {
    e.stopPropagation()
    await updateLeadStatus(lead.id!, status)
    await activityLogRepository.log(
      status === 'selected' ? 'lead_selected' : status === 'rejected' ? 'lead_rejected' : 'lead_updated',
      `${lead.companyName} → ${status}`, lead.sessionId
    )
    toast.success(status === 'selected' ? 'Marked as interested' : 'Marked as not relevant')
  }

  async function handleResearch(lead: Lead, e: React.MouseEvent) {
    e.stopPropagation()
    await addToResearchQueue(lead)
    await loadLeads()
    await activityLogRepository.log('lead_added_to_research', lead.companyName, lead.sessionId)
    toast.success(`${lead.companyName} added to research queue`)
  }

  function handleDelete(lead: Lead, e: React.MouseEvent) {
    e.stopPropagation()
    const id = lead.id!
    // Hide immediately from view
    setDeletingIds((s) => { const n = new Set(s); n.add(id); return n })
    // Schedule actual DB delete with 5s undo window
    const timer = setTimeout(async () => {
      pendingDeletes.current.delete(id)
      setDeletingIds((s) => { const n = new Set(s); n.delete(id); return n })
      const { deleteLead } = useLeadStore.getState()
      await deleteLead(id)
    }, 5000)
    pendingDeletes.current.set(id, { lead, timer })
    toast.info(`${lead.companyName} deleted`, () => {
      // Undo callback
      const pending = pendingDeletes.current.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingDeletes.current.delete(id)
        setDeletingIds((s) => { const n = new Set(s); n.delete(id); return n })
        toast.success(`${lead.companyName} restored`)
      }
    })
  }

  async function handleBulkStatus(status: LeadStatus) {
    const ids = Array.from(selectedIds)
    for (const id of ids) await updateLeadStatus(id, status)
    clearSelection()
    toast.success(`${ids.length} leads marked as ${status}`)
  }

  async function handleBulkCrmPush() {
    if (!settings.crmApiUrl) {
      toast.error('CRM URL not configured — go to Settings → CRM Integration')
      return
    }
    const selected = leads.filter((l) => l.id !== undefined && selectedIds.has(l.id))
    if (!selected.length) { toast.error('No leads selected'); return }
    toast.info(`Pushing ${selected.length} leads to CRM…`)
    const result = await pushBatchToCrm(selected, settings)
    clearSelection()
    if (result.failed === 0) {
      toast.success(`${result.pushed} leads pushed to CRM`)
    } else {
      toast.error(`${result.pushed} pushed, ${result.failed} failed`)
    }
  }

  async function handleCrmPush(lead: Lead, e: React.MouseEvent) {
    e.stopPropagation()
    if (!settings.crmApiUrl) {
      toast.error('CRM URL not set — go to Settings → CRM Integration')
      return
    }
    const result = await pushLeadToCrm(lead, settings)
    if (result.ok) toast.success(`${lead.companyName} pushed to CRM`)
    else toast.error(result.error ?? 'CRM push failed')
  }

  async function handleBulkResearch() {
    const selected = leads.filter((l) => l.id !== undefined && selectedIds.has(l.id))
    let queued = 0
    for (const lead of selected) {
      if (!lead.status.startsWith('research')) {
        await addToResearchQueue(lead)
        queued++
      }
    }
    clearSelection()
    await loadLeads()
    toast.success(`${queued} leads added to research queue`)
  }

  async function handleExportCSV() {
    const rows = selectedCount > 0
      ? leads.filter((l) => l.id !== undefined && selectedIds.has(l.id))
      : sorted
    const exportRows: ExportRowInput[] = await Promise.all(
      rows.map(async (l) => {
        const research = l.id !== undefined
          ? await researchResultRepository.getByLeadId(l.id).catch(() => undefined)
          : undefined
        return {
          name:               research?.decisionMaker || l.decisionMaker || l.companyName,
          phone:              l.phone,
          email:              research?.email,
          tags:               l.tags,
          creationDate:       l.capturedAt,
          companyName:        l.companyName,
          city:               l.city,
          category:           l.category ?? l.keyword,
          address:            l.address,
          website:            l.website ?? research?.website,
          rating:             l.rating,
          icpScore:           l.icpScore,
          icpStatus:          l.icpStatus,
          turnover:           l.annualTurnover ?? research?.annualTurnover,
          teamSize:           l.teamSize ?? research?.employeeCount,
          coreMember:         l.decisionMaker ?? research?.teamMembers?.map((m) => m.role ? `${m.name} (${m.role})` : m.name).join('; ') ?? research?.decisionMaker,
          workingDomain:      l.industry ?? research?.industry,
          companyType:        l.companyType ?? research?.companyType,
          cin:                l.cin,
          uan:                l.uan,
          defaultCountryCode: settings.interaktCountryCode,
        }
      })
    )
    exportRowsToCSV(exportRows, exportFilename('csv'))
    activityLogRepository.log('export_completed', `Exported ${rows.length} leads as CSV`)
    toast.success(`Exported ${rows.length} leads as CSV`)
  }

  function handleExportJSON() {
    const rows = selectedCount > 0
      ? leads.filter((l) => l.id !== undefined && selectedIds.has(l.id))
      : sorted
    exportToJSON(rows, exportFilename('json'))
    activityLogRepository.log('export_completed', `Exported ${rows.length} leads as JSON`)
    toast.success(`Exported ${rows.length} leads as JSON`)
  }

  async function handleExportDoc() {
    const rows = selectedCount > 0
      ? leads.filter((l) => l.id !== undefined && selectedIds.has(l.id))
      : sorted
    const researchMap = new Map<number, import('@/types/research').ResearchResult>()
    await Promise.all(
      rows.map(async (l) => {
        if (!l.id) return
        const r = await researchResultRepository.getByLeadId(l.id).catch(() => undefined)
        if (r) researchMap.set(l.id, r)
      })
    )
    exportToDoc(rows, researchMap, exportFilename('doc'))
    activityLogRepository.log('export_completed', `Exported ${rows.length} leads as DOC`)
    toast.success(`Exported ${rows.length} leads as Word document`)
  }

  function resetFilters() {
    setMinRating(0); setMinIcpScore(0)
    setHasPhone(null); setHasWebsite(null); setHasTeamSize(null); setHasTurnover(null)
    setSessionFilter(''); setSearch('')
    setHideNotRelevant(true)
  }

  async function handleReEnrich() {
    if (reEnriching) return
    if (!settings.geminiApiKey?.trim()) {
      toast.warning('Enrichment uses Gemini grounding — add your Gemini API key in Settings → AI Research')
      return
    }
    const { apiKey } = await resolveAiCredentials(settings)
    const allLeads = await leadRepository.getAll()
    if (allLeads.length === 0) { toast.info('No leads to enrich'); return }
    setReEnriching(true)
    setEnrichProgress({ done: 0, total: allLeads.length })
    let enrichedCount = 0

    const reloadFilter = filterStatus === 'selected'
      ? { statuses: ['selected', 'research_pending', 'research_running', 'research_completed', 'research_failed'] as import('@/types/lead').LeadStatus[] }
      : filterStatus ? { status: filterStatus as import('@/types/lead').LeadStatus } : {}

    try {
      // Clear ALL existing jobId=0 records so enrichment re-runs fresh for every lead
      const existing = await researchResultRepository.getAll()
      const allLeadIds = new Set(allLeads.map(l => l.id!))
      const staleLeadIds = [...new Set(
        existing.filter(r => r.jobId === 0 && allLeadIds.has(r.leadId)).map(r => r.leadId)
      )]
      for (const leadId of staleLeadIds) {
        await researchResultRepository.deleteByLeadId(leadId)
      }

      await runPreValidationEnrichment(allLeads, settings, apiKey, (done, total) => {
        enrichedCount = done
        setEnrichProgress({ done, total })
        // Reload table every 10 leads so data appears progressively
        if (done % 10 === 0 || done === total) {
          loadLeads(reloadFilter)
        }
      })

      // Final reload + summary
      loadLeads(reloadFilter)
      if (enrichedCount > 0) {
        toast.success(`Enrichment complete — ${enrichedCount} leads processed`)
      } else {
        toast.warning('Enrichment ran but no data returned — check Gemini API key in appsettings.json')
      }
    } catch (err) {
      toast.error('Re-enrichment failed — check console')
      console.error('[ReEnrich]', err)
    } finally {
      setReEnriching(false)
      setEnrichProgress(null)
    }
  }

  if (loading) return <TableSkeleton />

  const visibleRows = paginated.filter((l) => !deletingIds.has(l.id!))

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Primary toolbar — row 1 */}
      <div className="flex items-center gap-2 flex-wrap">
        {title && <h2 className="font-semibold text-white text-sm shrink-0">{title}</h2>}

        {/* Search Session scope chip (set from the Topbar switcher / session cards) */}
        {projectScope && (
          <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-purple-950/60 border border-purple-700 text-purple-300 rounded-full shrink-0">
            ◈ {projectScope.name}
            <button
              onClick={() => setProjectScope(null)}
              className="text-purple-400 hover:text-white font-bold leading-none"
              title="Clear session filter"
            >×</button>
          </span>
        )}

        {/* Market drill-down scope chip (set from the Markets page) */}
        {marketScope && (
          <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-blue-950/60 border border-blue-700 text-blue-300 rounded-full shrink-0">
            {marketScope.countryName}{marketScope.city ? ` › ${marketScope.city}` : ''}
            <button
              onClick={() => setMarketScope(null)}
              className="text-blue-400 hover:text-white font-bold leading-none"
              title="Clear market filter"
            >×</button>
          </span>
        )}

        <input
          type="text"
          placeholder="Search leads…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          className="bg-gray-800 border border-gray-700 text-white text-xs px-3 py-1.5 rounded-lg
            placeholder-gray-600 focus:outline-none focus:border-blue-500 w-40 shrink-0"
        />

        <button
          onClick={() => { setShowFilters((v) => !v); setShowCols(false) }}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors shrink-0
            ${showFilters || activeFilterCount > 0
              ? 'bg-blue-900/50 border-blue-700 text-blue-300'
              : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
            }`}
        >
          Filters
          {activeFilterCount > 0 && (
            <span className="bg-blue-600 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">
              {activeFilterCount}
            </span>
          )}
        </button>

        <div className="relative shrink-0">
          <button
            onClick={() => { setShowCols((v) => !v); setShowFilters(false) }}
            className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors
              ${showCols ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'}`}
          >
            Columns
          </button>
          {showCols && (
            <div className="absolute top-8 left-0 z-20 bg-gray-900 border border-gray-700 rounded-xl shadow-xl p-3 w-44">
              {ALL_COLUMNS.map((c) => (
                <label key={c} className="flex items-center gap-2 py-1 cursor-pointer hover:text-white text-xs text-gray-300">
                  <input
                    type="checkbox"
                    checked={visibleCols.has(c)}
                    onChange={() => toggleCol(c)}
                    className="accent-blue-500"
                  />
                  {COL_LABELS[c]}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-xs text-gray-500 shrink-0">{sorted.length} leads</span>

        {/* Re-enrich button — fills teamSize/turnover/industry for leads missing enrichment data */}
        {!filterStatus && (
          <button
            onClick={handleReEnrich}
            disabled={reEnriching}
            title="Re-run AI enrichment for leads missing Team Size / Turnover / Industry data"
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors shrink-0 ${
              reEnriching
                ? 'bg-purple-900/40 border-purple-700 text-purple-400 cursor-wait'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-purple-300 hover:border-purple-700'
            }`}
          >
            {reEnriching ? '⟳ Enriching…' : '⚙ Re-enrich'}
          </button>
        )}

        {/* Hide Not Relevant toggle */}
        {!filterStatus && (
          <button
            onClick={() => setHideNotRelevant((v) => !v)}
            title={hideNotRelevant ? 'Show not-relevant leads' : 'Hide not-relevant leads'}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors shrink-0 ${
              hideNotRelevant
                ? 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
                : 'bg-orange-950/50 border-orange-800/50 text-orange-300'
            }`}
          >
            {hideNotRelevant ? 'Hide Irrelevant' : 'Show All'}
          </button>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button onClick={selectAll}
            className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700">
            All
          </button>
          <button onClick={handleExportCSV}
            className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700">
            CSV
          </button>
          <button onClick={handleExportJSON}
            className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700">
            JSON
          </button>
          <button onClick={handleExportDoc}
            className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700"
            title="Export as Word document (.doc) — opens in Microsoft Word or Google Docs">
            DOC
          </button>
          <button
            onClick={() => setCompact((v) => !v)}
            title={compact ? 'Comfortable view' : 'Compact view'}
            className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              compact ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
            }`}
          >
            {compact ? '▤' : '▦'}
          </button>
        </div>
      </div>

      {/* Enrichment progress bar */}
      {enrichProgress && (
        <div className="flex flex-col gap-1 bg-purple-950/40 border border-purple-800/40 rounded-xl px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-purple-300 font-medium">
              ⚙ Gemini enrichment — {enrichProgress.done} / {enrichProgress.total} leads
            </span>
            <span className="text-xs text-purple-400 tabular-nums">
              {Math.round((enrichProgress.done / enrichProgress.total) * 100)}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-purple-950 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-500"
              style={{ width: `${(enrichProgress.done / enrichProgress.total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-purple-500">
            ~{Math.ceil((enrichProgress.total - enrichProgress.done) * 1.5 / 60)} min remaining · data updates every 10 leads
          </span>
        </div>
      )}

      {/* Bulk action bar — shown only when leads are selected */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 bg-blue-950/40 border border-blue-800/40 rounded-xl px-3 py-2">
          <span className="text-xs text-blue-400 font-medium shrink-0">{selectedCount} selected</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={() => handleBulkStatus('selected')}
              className="text-xs px-2.5 py-1 bg-green-900 hover:bg-green-800 text-green-200 rounded-lg transition-colors">
              ✓ Interested
            </button>
            <button onClick={() => handleBulkStatus('rejected')}
              className="text-xs px-2.5 py-1 bg-red-900 hover:bg-red-800 text-red-200 rounded-lg transition-colors">
              ✕ Reject
            </button>
            <button onClick={handleBulkResearch}
              className="text-xs px-2.5 py-1 bg-purple-900 hover:bg-purple-800 text-purple-200 rounded-lg transition-colors">
              ⚗ Research
            </button>
            {settings.crmApiUrl && (
              <button onClick={handleBulkCrmPush}
                className="text-xs px-2.5 py-1 bg-blue-900 hover:bg-blue-800 text-blue-200 rounded-lg transition-colors">
                ⇥ Push to CRM
              </button>
            )}
          </div>
          <button onClick={clearSelection}
            className="ml-auto text-xs px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors">
            Clear
          </button>
        </div>
      )}

      {/* Filter bar */}
      {showFilters && (
        <div className="flex items-center gap-3 flex-wrap bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Session</label>
            <select
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value === '' ? '' : Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500 max-w-[160px]"
            >
              <option value="">All</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.keyword} — {s.city}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Min rating</label>
            <select
              value={minRating}
              onChange={(e) => setMinRating(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500"
            >
              <option value={0}>Any</option>
              <option value={3}>3★+</option>
              <option value={3.5}>3.5★+</option>
              <option value={4}>4★+</option>
              <option value={4.5}>4.5★+</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Phone</label>
            <TriToggle value={hasPhone} onChange={setHasPhone} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Website</label>
            <TriToggle value={hasWebsite} onChange={setHasWebsite} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Min ICP</label>
            <select
              value={minIcpScore}
              onChange={(e) => setMinIcpScore(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500"
            >
              <option value={0}>Any</option>
              <option value={50}>50+</option>
              <option value={60}>60+</option>
              <option value={70}>70+</option>
              <option value={80}>80+</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Team Size</label>
            <TriToggle value={hasTeamSize} onChange={setHasTeamSize} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Turnover</label>
            <TriToggle value={hasTurnover} onChange={setHasTurnover} />
          </div>
          {activeFilterCount > 0 && (
            <button onClick={resetFilters}
              className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700 ml-auto">
              Reset
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-800" onClick={() => setShowCols(false)}>
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-56 text-gray-600">
            <div className="text-4xl mb-3 opacity-20">☰</div>
            <div className="text-sm text-gray-500">No leads found</div>
            <div className="text-xs mt-1 text-gray-700">
              {search || activeFilterCount > 0
                ? <button onClick={resetFilters} className="text-blue-500 hover:text-blue-400 transition-colors">Clear filters</button>
                : 'Start a search to capture business leads'}
            </div>
          </div>
        ) : (
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-900 border-b border-gray-800 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-3 text-gray-500 font-medium w-8">
                  <input type="checkbox" className="accent-blue-500"
                    checked={selectedCount > 0 && selectedCount === sorted.length}
                    onChange={(e) => e.target.checked ? selectAll() : clearSelection()} />
                </th>
                <th className="px-3 py-3 text-gray-500 font-medium">
                  <button onClick={() => toggleSort('companyName')} className="flex items-center hover:text-white transition-colors">
                    Company {sortIcon('companyName')}
                  </button>
                </th>
                {col('icpScore') && (
                  <th className="px-3 py-3 text-gray-500 font-medium w-24">
                    <button onClick={() => toggleSort('icpScore')} className="flex items-center hover:text-white transition-colors">
                      ICP Score {sortIcon('icpScore')}
                    </button>
                  </th>
                )}
                {col('score') && (
                  <th className="px-3 py-3 text-gray-500 font-medium w-24">
                    <button onClick={() => toggleSort('score')} className="flex items-center hover:text-white transition-colors">
                      Map Score {sortIcon('score')}
                    </button>
                  </th>
                )}
                {col('teamSize') && <th className="px-3 py-3 text-gray-500 font-medium w-24">Team Size</th>}
                {col('turnover') && <th className="px-3 py-3 text-gray-500 font-medium w-28">Turnover</th>}
                {col('category') && <th className="px-3 py-3 text-gray-500 font-medium">Category</th>}
                {col('rating') && (
                  <th className="px-3 py-3 text-gray-500 font-medium w-20">
                    <button onClick={() => toggleSort('rating')} className="flex items-center hover:text-white transition-colors">
                      Rating {sortIcon('rating')}
                    </button>
                  </th>
                )}
                {col('phone')   && <th className="px-3 py-3 text-gray-500 font-medium">Phone</th>}
                {col('website') && <th className="px-3 py-3 text-gray-500 font-medium">Website</th>}
                {col('status')  && <th className="px-3 py-3 text-gray-500 font-medium w-24">Status</th>}
                {col('date') && !compact && (
                  <th className="px-3 py-3 text-gray-500 font-medium w-32">
                    <button onClick={() => toggleSort('capturedAt')} className="flex items-center hover:text-white transition-colors">
                      Captured {sortIcon('capturedAt')}
                    </button>
                  </th>
                )}
                <th className="px-3 py-3 text-gray-500 font-medium w-28">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  selected={lead.id !== undefined && selectedIds.has(lead.id)}
                  compact={compact}
                  visibleCols={visibleCols}
                  showCrmButton={!!settings.crmApiUrl}
                  onToggle={(e) => { e.stopPropagation(); toggleSelect(lead.id!) }}
                  onRowClick={() => openDetail(lead)}
                  onStatusChange={(s, e) => handleStatusChange(lead, s, e)}
                  onResearch={(e) => handleResearch(lead, e)}
                  onCrmPush={(e) => handleCrmPush(lead, e)}
                  onDelete={(e) => handleDelete(lead, e)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500 shrink-0">
          <span>Showing {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, sorted.length)} of {sorted.length}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(1)} disabled={page === 1}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-30 transition-colors">«</button>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-30 transition-colors">‹</button>
            <span className="px-3 py-1 text-white">{page} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-30 transition-colors">›</button>
            <button onClick={() => setPage(totalPages)} disabled={page === totalPages}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-30 transition-colors">»</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TriToggle ────────────────────────────────────────────────────────────────

function TriToggle({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-700">
      {([null, true, false] as (boolean | null)[]).map((opt, i) => (
        <button key={i} onClick={() => onChange(opt)}
          className={`px-2.5 py-1 text-xs transition-colors ${value === opt ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-500 hover:text-white'}`}>
          {['Any', 'Yes', 'No'][i]}
        </button>
      ))}
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="h-7 w-44 bg-gray-800 rounded-lg animate-pulse" />
        <div className="h-7 w-24 bg-gray-800 rounded-lg animate-pulse" />
        <div className="ml-auto h-7 w-20 bg-gray-800 rounded-lg animate-pulse" />
      </div>
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <div className="h-10 bg-gray-900 border-b border-gray-800" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-3 border-b border-gray-800">
            <div className="w-4 h-4 bg-gray-800 rounded animate-pulse" />
            <div className="flex-1 h-4 bg-gray-800 rounded animate-pulse" style={{ maxWidth: `${60 + (i % 3) * 20}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Lead row ─────────────────────────────────────────────────────────────────

interface LeadRowProps {
  lead: Lead
  selected: boolean
  compact: boolean
  visibleCols: Set<ColKey>
  showCrmButton: boolean
  onToggle: (e: React.MouseEvent) => void
  onRowClick: () => void
  onStatusChange: (s: LeadStatus, e: React.MouseEvent) => void
  onResearch: (e: React.MouseEvent) => void
  onCrmPush: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
}

function LeadRow({ lead, selected, compact, visibleCols, showCrmButton, onToggle, onRowClick, onStatusChange, onResearch, onCrmPush, onDelete }: LeadRowProps) {
  const py = compact ? 'py-1.5' : 'py-2.5'
  const col = (k: ColKey) => visibleCols.has(k)

  return (
    <tr
      className={`border-b border-gray-800/60 transition-colors cursor-pointer hover:bg-gray-800/60 ${selected ? 'bg-blue-950/25' : ''}`}
      onClick={onRowClick}
    >
      <td className={`px-3 ${py}`} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="accent-blue-500" checked={selected} onChange={() => {}} onClick={onToggle} />
      </td>
      <td className={`px-3 ${py}`}>
        <div className="font-medium text-white truncate max-w-[150px]" title={lead.companyName}>{lead.companyName}</div>
        {!compact && <div className="text-gray-600 text-xs">{lead.city}</div>}
        {lead.validationStatus === 'relevant'     && <div className="text-green-500 text-xs mt-0.5">✓ Relevant</div>}
        {lead.validationStatus === 'not_relevant' && <div className="text-gray-600 text-xs mt-0.5">✕ Not relevant</div>}
        {lead.notes && <div className="text-yellow-700 text-xs mt-0.5 truncate max-w-[140px]" title={lead.notes}>✎ {lead.notes}</div>}
      </td>
      {col('icpScore') && (
        <td className={`px-3 ${py}`}>
          {lead.icpScore !== undefined ? (
            <div className="flex flex-col gap-0.5">
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                lead.icpScore >= 80 ? 'bg-green-900/60 text-green-300' :
                lead.icpScore >= 60 ? 'bg-blue-900/60 text-blue-300' :
                lead.icpScore >= 50 ? 'bg-yellow-900/60 text-yellow-300' :
                'bg-red-900/60 text-red-400'
              }`}>{lead.icpScore}</span>
              {lead.icpStatus && (
                <span className="text-gray-600 text-xs">{lead.icpStatus.replace('_', ' ')}</span>
              )}
            </div>
          ) : <span className="text-gray-700">—</span>}
        </td>
      )}
      {col('score') && (
        <td className={`px-3 ${py}`}>
          <ScoreBadge lead={lead} />
        </td>
      )}
      {col('teamSize') && (
        <td className={`px-3 ${py} text-gray-400`}>
          {lead.teamSize
            ? <span>{lead.teamSize}{lead.teamSizeVerified === false && <span className="ml-1 text-xs text-yellow-600 font-medium">Est.</span>}</span>
            : '—'}
        </td>
      )}
      {col('turnover') && (
        <td className={`px-3 ${py} text-gray-400`}>
          {lead.annualTurnover
            ? <span>{lead.annualTurnover}{lead.turnoverVerified === false && <span className="ml-1 text-xs text-yellow-600 font-medium">Est.</span>}</span>
            : '—'}
        </td>
      )}
      {col('category') && (
        <td className={`px-3 ${py} text-gray-400 truncate max-w-[110px]`}>{lead.category ?? lead.keyword ?? '—'}</td>
      )}
      {col('rating') && (
        <td className={`px-3 ${py}`}>
          {lead.rating != null
            ? <span className="text-yellow-400 font-medium">{lead.rating}★</span>
            : <span className="text-gray-700">—</span>}
          {!compact && lead.reviewCount != null && (
            <div className="text-gray-600">({Number(lead.reviewCount).toLocaleString()})</div>
          )}
        </td>
      )}
      {col('phone') && (
        <td className={`px-3 ${py}`}>
          {lead.phone
            ? <div className="flex items-center gap-1"><span className="text-gray-300">{lead.phone}</span><CopyBtn value={lead.phone} /></div>
            : <span className="text-gray-700">—</span>}
        </td>
      )}
      {col('website') && (
        <td className={`px-3 ${py} max-w-[110px]`}>
          {lead.website
            ? <div className="flex items-center gap-1">
                <a href={lead.website} target="_blank" rel="noreferrer"
                  className="text-blue-400 hover:text-blue-300 hover:underline truncate block max-w-[80px] transition-colors"
                  title={lead.website} onClick={(e) => e.stopPropagation()}>
                  {lead.website.replace(/^https?:\/\//, '').split('/')[0]}
                </a>
                <CopyBtn value={lead.website} />
              </div>
            : <span className="text-gray-700">—</span>}
        </td>
      )}
      {col('status') && (
        <td className={`px-3 ${py}`}><StatusBadge status={lead.status} size="xs" /></td>
      )}
      {col('date') && !compact && (
        <td className={`px-3 ${py} text-gray-600`}>{formatDateTime(lead.capturedAt)}</td>
      )}
      <td className={`px-3 ${py}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-1">
          {lead.status !== 'selected' && (
            <ActionBtn onClick={(e) => onStatusChange('selected', e)} title="Interested" cls="bg-green-900/60 hover:bg-green-800 text-green-300">✓</ActionBtn>
          )}
          {lead.status !== 'rejected' && (
            <ActionBtn onClick={(e) => onStatusChange('rejected', e)} title="Reject" cls="bg-red-900/60 hover:bg-red-800 text-red-300">✕</ActionBtn>
          )}
          {!lead.status.startsWith('research') && (
            <ActionBtn onClick={onResearch} title="Research" cls="bg-purple-900/60 hover:bg-purple-800 text-purple-300">⚗</ActionBtn>
          )}
          {showCrmButton && (
            <ActionBtn onClick={onCrmPush} title="Push to CRM" cls="bg-blue-900/60 hover:bg-blue-800 text-blue-300">⇥</ActionBtn>
          )}
          {lead.googleMapsUrl && (
            <a href={lead.googleMapsUrl} target="_blank" rel="noreferrer"
              className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded text-xs transition-colors"
              title="Maps" onClick={(e) => e.stopPropagation()}>⌖</a>
          )}
          <ActionBtn onClick={onDelete} title="Delete" cls="bg-gray-800 hover:bg-red-950 text-gray-600 hover:text-red-400">×</ActionBtn>
        </div>
      </td>
    </tr>
  )
}

function ActionBtn({ children, onClick, title, cls }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; title: string; cls: string }) {
  return (
    <button onClick={onClick} title={title} className={`px-1.5 py-0.5 rounded text-xs transition-colors ${cls}`}>
      {children}
    </button>
  )
}
