import React, { useEffect, useState } from 'react'
import {
  fetchPhase3Companies, fetchPhase3CompanyDetail,
  type ApiCompanyResearch, type ApiCompanyResearchDetail,
  type ApiSearchEvidence, type ApiSourcePage,
} from '@/services/apiResearchService'
import { exportFullCSV } from '@/utils/csvExport'
import { useLeadStore } from '@/state/useLeadStore'
import { leadRepository } from '@/db/leadRepository'

export default function CompanyIntelligencePage() {
  const [rows, setRows] = useState<ApiCompanyResearch[]>([])
  const [loading, setLoading] = useState(true)
  const [apiError, setApiError] = useState(false)
  const [selected, setSelected] = useState<ApiCompanyResearch | null>(null)
  const [detail, setDetail] = useState<ApiCompanyResearchDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const { projectScope } = useLeadStore()

  async function load() {
    setLoading(true)
    setApiError(false)
    try {
      let companies = await fetchPhase3Companies()
      if (companies.length === 0) {
        // Distinguish between "API offline" and "no data yet" by probing health
        const health = await fetch('http://localhost:5150/api/health', { signal: AbortSignal.timeout(2000) }).catch(() => null)
        if (!health?.ok) setApiError(true)
      }
      // Global Search Session scope — the rows come from MSSQL, so map the
      // scope through local leads' mssqlId links.
      if (projectScope) {
        const scopedLeads = await leadRepository.getByFilter({ projectId: projectScope.id })
        const allowed = new Set(scopedLeads.map((l) => l.mssqlId).filter(Boolean))
        companies = companies.filter((c) => c.mssqlId && allowed.has(c.mssqlId))
      }
      setRows(companies)
    } catch {
      setApiError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [projectScope])

  useEffect(() => {
    if (!selected?.mssqlId) { setDetail(null); return }
    setDetailLoading(true)
    fetchPhase3CompanyDetail(selected.mssqlId).then((d) => {
      setDetail(d)
      setDetailLoading(false)
    })
  }, [selected])

  function handleExportCSV() {
    const headers = [
      'Company Name', 'City', 'Official Website', 'LinkedIn', 'Facebook', 'Instagram',
      'IndiaMART', 'TradeIndia', 'Owner/Director', 'Directors', 'Products/Services',
      'Business Type', 'Team Size', 'Turnover', 'Established Year', 'Address',
      'Phone', 'Email', 'Confidence', 'Updated At',
    ]
    const exportRows = rows.map((r) => [
      r.companyName, r.city, r.officialWebsite, r.linkedinUrl, r.facebookUrl, r.instagramUrl,
      r.indiamartUrl, r.tradeindiaUrl, r.ownerName, r.directors, r.productsServices,
      r.businessType, r.teamSize, r.turnover, r.establishedYear, r.address,
      r.phone, r.email, Math.round(r.confidence * 100) + '%', r.updatedAt,
    ])
    exportFullCSV(headers, exportRows, `company-intelligence-export-${Date.now()}.csv`)
  }

  function handleExportJSON() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `company-intelligence-export-${Date.now()}.json`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading company intelligence from MSSQL…</div>
  }

  if (apiError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <div className="text-red-400 text-sm font-semibold">API Offline</div>
        <div className="text-gray-500 text-xs text-center max-w-64">
          Cannot reach the DeepLead API at localhost:5150. Start the API server and reload.
          <br />Company Intelligence data is stored in MSSQL — it will not fall back to local cache.
        </div>
        <button onClick={load} className="mt-2 text-xs px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded-lg">
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {/* Left list */}
      <div className="w-80 shrink-0 flex flex-col gap-2 min-h-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Companies ({rows.length})</h3>
          <div className="flex gap-1.5">
            <button onClick={handleExportCSV} className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors">CSV</button>
            <button onClick={handleExportJSON} className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors">JSON</button>
            <button onClick={load} className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors" title="Refresh from MSSQL">↻</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
          {rows.length === 0 && (
            <div className="text-xs text-gray-600 px-2 py-8 text-center">No company intelligence yet — run research from the Lead Database.</div>
          )}
          {rows.map((r) => (
            <button
              key={r.mssqlId}
              onClick={() => setSelected(r)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                selected?.mssqlId === r.mssqlId ? 'bg-blue-950/50 border-blue-700' : 'bg-gray-900 border-gray-800 hover:border-gray-700'
              }`}
            >
              <div className="text-sm font-medium text-white truncate">{r.companyName}</div>
              <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                <span>{r.city ?? '—'}</span>
                <span className={`px-1.5 py-0.5 rounded-full ${
                  r.confidence >= 0.7 ? 'bg-green-950 text-green-400' : r.confidence >= 0.4 ? 'bg-yellow-950 text-yellow-400' : 'bg-red-950 text-red-400'
                }`}>{Math.round(r.confidence * 100)}%</span>
                {r.sourcePagesCount != null && r.sourcePagesCount > 0 && (
                  <span className="text-gray-600">{r.sourcePagesCount} sources</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">Select a company to view evidence and extracted data</div>
        ) : detailLoading ? (
          <div className="h-full flex items-center justify-center text-gray-500 text-sm">Loading from MSSQL…</div>
        ) : detail ? (
          <CompanyDetail detail={detail} />
        ) : (
          <div className="h-full flex items-center justify-center text-red-400 text-sm">Failed to load detail — API may be offline.</div>
        )}
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm text-gray-200">{value}</div>
    </div>
  )
}

function CompanyDetail({ detail }: { detail: ApiCompanyResearchDetail }) {
  const sourceLinks = [
    { label: 'Official Website', url: detail.officialWebsite },
    { label: 'LinkedIn', url: detail.linkedinUrl },
    { label: 'Facebook', url: detail.facebookUrl },
    { label: 'Instagram', url: detail.instagramUrl },
    { label: 'IndiaMART', url: detail.indiamartUrl },
    { label: 'TradeIndia', url: detail.tradeindiaUrl },
  ].filter((s) => s.url)

  const acceptedEvidence = detail.evidence.filter((e) => !e.rejected)
  const rejectedEvidence = detail.evidence.filter((e) => e.rejected)

  return (
    <div className="space-y-5 pb-6">
      {/* Company profile */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">{detail.companyName}</h2>
          <span className={`text-xs px-2 py-1 rounded-full font-semibold ${
            detail.confidence >= 0.7 ? 'bg-green-950 text-green-400' : detail.confidence >= 0.4 ? 'bg-yellow-950 text-yellow-400' : 'bg-red-950 text-red-400'
          }`}>Confidence: {Math.round(detail.confidence * 100)}%</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Owner/Director" value={detail.ownerName} />
          <Field label="Business Type" value={detail.businessType} />
          <Field label="Team Size" value={detail.teamSize} />
          <Field label="Turnover" value={detail.turnover} />
          <Field label="Established" value={detail.establishedYear} />
          <Field label="Phone" value={detail.phone} />
          <Field label="Email" value={detail.email} />
          <Field label="Address" value={detail.address} />
        </div>
        {detail.directors && <Field label="Directors / Team" value={detail.directors} />}
        {detail.productsServices && <Field label="Products / Services" value={detail.productsServices} />}
      </section>

      {/* Source links */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Source Links (verify manually)</h3>
        {sourceLinks.length === 0 ? (
          <div className="text-xs text-gray-600">No source links resolved.</div>
        ) : (
          <div className="space-y-1.5">
            {sourceLinks.map((s) => (
              <div key={s.label} className="text-xs">
                <span className="text-gray-500 w-28 inline-block">{s.label}:</span>
                <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{s.url}</a>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Sequential per-source-type intelligence — priority order */}
      <SourceIntelligenceSections sourcePages={detail.sourcePages} />

      {/* Raw search evidence */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
          Raw Google Evidence ({acceptedEvidence.length} accepted, {rejectedEvidence.length} rejected)
        </h3>
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {detail.evidence.sort((a: ApiSearchEvidence, b: ApiSearchEvidence) => a.rank - b.rank).map((e: ApiSearchEvidence) => (
            <div key={e.id} className={`text-xs rounded-lg p-2 border ${e.rejected ? 'bg-red-950/20 border-red-900/40' : 'bg-gray-950 border-gray-800'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-300 truncate">#{e.rank} {e.title}</span>
                <span className="shrink-0 text-gray-500">{e.detectedType}</span>
              </div>
              <a href={e.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all block mt-0.5">{e.url}</a>
              <div className="text-gray-500 mt-0.5">{e.snippet}</div>
              {e.rejected && <div className="text-red-400 mt-1">Rejected: {e.rejectReason}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// ── Sequential per-source-type intelligence sections ─────────────────────────
// Priority order: official website → corporate registry → LinkedIn → industry
// directory → marketplace → news → review site → social pages → others.
// Each section shows exactly what was scraped from that source family.

const SOURCE_SECTION_ORDER: Array<{ types: string[]; label: string; icon: string }> = [
  { types: ['official_website'],                 label: 'Official Website',    icon: '🌐' },
  { types: ['corporate_registry', 'zaubacorp'],  label: 'Corporate Registry',  icon: '🏛️' },
  { types: ['linkedin'],                         label: 'LinkedIn Company Page', icon: '💼' },
  { types: ['company_directory'],                label: 'Industry Directory',  icon: '📇' },
  { types: ['indiamart', 'tradeindia'],          label: 'Marketplace',         icon: '🛒' },
  { types: ['news'],                             label: 'News',                icon: '📰' },
  { types: ['review_site', 'ambitionbox'],       label: 'Review Site',         icon: '⭐' },
  { types: ['facebook', 'instagram', 'youtube'], label: 'Social Pages',        icon: '📱' },
]

// Extraction fields worth showing as a labeled grid (skip internals)
const EXTRACT_FIELD_LABELS: Record<string, string> = {
  industry: 'Industry', companyType: 'Company Type', companyTypeNormalized: 'Type (normalized)',
  employeeCount: 'Employees', annualTurnover: 'Turnover', annualTurnoverCurrency: 'Currency',
  annualTurnoverApproxUsd: 'Turnover (approx USD)', yearFounded: 'Founded',
  decisionMaker: 'Decision Maker', decisionMakerRole: 'DM Role', summary: 'Summary',
  email: 'Email', alternatePhone: 'Phone', website: 'Website', headquarters: 'HQ',
  linkedinFollowers: 'LinkedIn Followers', linkedinAbout: 'LinkedIn About',
  sourceLanguage: 'Source Language',
}

function ExtractedFieldsGrid({ json }: { json: string }) {
  let data: Record<string, unknown>
  try { data = JSON.parse(json) } catch { return null }

  const rows = Object.entries(EXTRACT_FIELD_LABELS)
    .map(([key, label]) => ({ key, label, value: data[key] }))
    .filter((r) => r.value !== undefined && r.value !== null && r.value !== '')

  const services = Array.isArray(data.services) ? (data.services as string[]).join('; ') : null
  const team = Array.isArray(data.teamMembers)
    ? (data.teamMembers as { name: string; role: string }[]).map((t) => `${t.name}${t.role ? ` (${t.role})` : ''}`).join(', ')
    : null
  const quotes = (data.originalQuotes && typeof data.originalQuotes === 'object')
    ? Object.entries(data.originalQuotes as Record<string, string>)
    : []

  if (rows.length === 0 && !services && !team) {
    return <div className="text-xs text-gray-600">Fetched, but no company facts were extractable from this source.</div>
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="text-xs">
            <span className="text-gray-500">{r.label}: </span>
            <span className="text-gray-200">{String(r.value)}</span>
          </div>
        ))}
      </div>
      {services && <div className="text-xs"><span className="text-gray-500">Products/Services: </span><span className="text-gray-200">{services}</span></div>}
      {team && <div className="text-xs"><span className="text-gray-500">Team: </span><span className="text-gray-200">{team}</span></div>}
      {quotes.length > 0 && (
        <details className="text-xs">
          <summary className="text-gray-500 cursor-pointer">Original-language quotes ({quotes.length})</summary>
          <div className="mt-1 space-y-1 pl-2 border-l border-gray-800">
            {quotes.map(([field, quote]) => (
              <div key={field}><span className="text-gray-600">{field}: </span><span className="text-gray-400" dir="auto">{quote}</span></div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function SourceIntelligenceSections({ sourcePages }: { sourcePages: ApiSourcePage[] }) {
  const grouped = SOURCE_SECTION_ORDER.map((section) => ({
    ...section,
    pages: sourcePages.filter((p) => section.types.includes(p.sourceType)),
  }))
  const knownTypes = new Set(SOURCE_SECTION_ORDER.flatMap((s) => s.types))
  const others = sourcePages.filter((p) => !knownTypes.has(p.sourceType))

  const sections = [...grouped, { types: [], label: 'Other Sources', icon: '📎', pages: others }]
    .filter((s) => s.pages.length > 0)

  if (sections.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Source Intelligence</h3>
        <div className="text-xs text-gray-600">No source pages visited.</div>
      </section>
    )
  }

  return (
    <>
      {sections.map((section) => (
        <section key={section.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            {section.icon} {section.label}
          </h3>
          <div className="space-y-2.5">
            {section.pages.map((s) => (
              <div key={s.id} className="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{s.url}</a>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] ${
                    s.status === 'extracted' ? 'bg-green-950 text-green-400'
                      : s.status === 'failed' ? 'bg-red-950 text-red-400'
                      : s.status === 'blocked' ? 'bg-orange-950 text-orange-400'
                      : 'bg-gray-800 text-gray-400'
                  }`}>{s.status}{s.confidence != null ? ` ${Math.round(s.confidence * 100)}%` : ''}</span>
                </div>
                {s.errorMessage && <div className="text-xs text-orange-400">{s.errorMessage}</div>}
                {s.extractedJson
                  ? <ExtractedFieldsGrid json={s.extractedJson} />
                  : !s.errorMessage && <div className="text-xs text-gray-600">No data extracted.</div>}
                {s.extractedJson && (
                  <details className="text-xs">
                    <summary className="text-gray-600 cursor-pointer">Raw JSON</summary>
                    {(() => {
                      try {
                        return <pre className="whitespace-pre-wrap break-all text-gray-500 bg-gray-900 rounded p-2 max-h-48 overflow-y-auto mt-1">{JSON.stringify(JSON.parse(s.extractedJson), null, 2)}</pre>
                      } catch { return null }
                    })()}
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
