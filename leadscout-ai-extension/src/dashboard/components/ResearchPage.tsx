import React, { useEffect, useState, useCallback } from 'react'
import type { ResearchResult } from '@/types/research'
import type { Lead } from '@/types/lead'
import type { DeepResearch } from '@/types/deepResearch'
import { researchResultRepository } from '@/db/researchResultRepository'
import { leadRepository } from '@/db/leadRepository'
import { db } from '@/db/db'
import { runDeepResearch } from '@/services/deepResearchService'
import CopyBtn from './CopyBtn'

type DetailTab = 'business' | 'persona' | 'contact' | 'social'

interface EnrichedResult extends ResearchResult {
  lead?: Lead
}

export default function ResearchPage() {
  const [results, setResults] = useState<EnrichedResult[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<EnrichedResult | null>(null)

  async function load() {
    const all = await researchResultRepository.getAll()
    const enriched = await Promise.all(
      all.map(async (r) => {
        const lead = await leadRepository.getById(r.leadId).catch(() => undefined)
        return { ...r, lead: lead ?? undefined }
      })
    )
    enriched.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    setResults(enriched)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const conf = (r: ResearchResult) => Math.round(r.confidence * 100)
  const confColor = (r: ResearchResult) => {
    const c = conf(r)
    return c >= 75 ? 'text-green-400' : c >= 50 ? 'text-yellow-400' : 'text-gray-500'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
        Loading research results…
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <div className="text-4xl opacity-30">⚗</div>
        <div className="text-gray-500 text-sm">No research completed yet</div>
        <div className="text-gray-700 text-xs">Select leads → Research Queue → Run Now</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {/* Left: result list */}
      <div className="w-72 shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">
        <div className="text-xs text-gray-500 mb-1">
          {results.length} researched {results.length === 1 ? 'lead' : 'leads'}
        </div>
        {results.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r)}
            className={`w-full text-left rounded-xl border px-3 py-3 transition-colors ${
              selected?.id === r.id
                ? 'bg-purple-950/60 border-purple-700'
                : 'bg-gray-900 border-gray-800 hover:border-gray-700'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">
                  {r.lead?.companyName ?? `Lead #${r.leadId}`}
                </div>
                <div className="text-xs text-gray-500 mt-0.5 truncate">
                  {r.lead?.city ?? ''}{r.industry ? ` · ${r.industry}` : ''}
                </div>
              </div>
              <span className={`text-xs font-semibold shrink-0 ${confColor(r)}`}>{conf(r)}%</span>
            </div>
            {r.decisionMaker && (
              <div className="text-xs text-purple-400 mt-1.5 truncate">👤 {r.decisionMaker}</div>
            )}
            {r.supplierBuyerType && (
              <div className="mt-1">
                <SupplierBadge type={r.supplierBuyerType} />
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Right: detail */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {!selected ? (
          <div className="flex items-center justify-center h-full text-gray-700 text-sm">
            Select a result on the left to view full details
          </div>
        ) : (
          <ResultDetail result={selected} />
        )}
      </div>
    </div>
  )
}

function ResultDetail({ result }: { result: EnrichedResult }) {
  const [tab, setTab] = useState<DetailTab>('business')
  const [deepResearch, setDeepResearch] = useState<DeepResearch | null>(null)
  const [deepRunning, setDeepRunning] = useState(false)
  const [deepError, setDeepError] = useState<string | null>(null)
  const [deepProgress, setDeepProgress] = useState<string>('')

  // Load existing deep research on result change
  useEffect(() => {
    setDeepResearch(null)
    setDeepError(null)
    if (!result.id) return
    db.deepResearch.where('researchResultId').equals(result.id).first().then(r => {
      if (r) setDeepResearch(r)
    })
  }, [result.id])

  const handleDeepResearch = useCallback(async () => {
    if (!result.lead || !result.id) return
    setDeepRunning(true)
    setDeepError(null)
    setDeepProgress('Starting deep research…')
    try {
      const keyRecord = await db.settings.get('openAiApiKey')
      const modelRecord = await db.settings.get('openAiModel')
      const apiKey = keyRecord?.value ?? ''
      const model = modelRecord?.value ?? 'gpt-4o-mini'
      if (!apiKey) throw new Error('OpenAI API key not set — go to Settings → AI Research → OpenAI')

      const dr = await runDeepResearch(
        result, result.lead, apiKey, model,
        (msg) => setDeepProgress(msg),
      )
      const id = await db.deepResearch.add(dr)
      setDeepResearch({ ...dr, id: id as number })
    } catch (err: any) {
      setDeepError(err?.message ?? 'Deep research failed')
    } finally {
      setDeepRunning(false)
      setDeepProgress('')
    }
  }, [result])

  const c = Math.round(result.confidence * 100)
  const confColor = c >= 75 ? 'text-green-400 bg-green-950/30 border-green-900/50'
    : c >= 50 ? 'text-yellow-400 bg-yellow-950/30 border-yellow-900/50'
    : 'text-gray-400 bg-gray-900 border-gray-800'

  const hasContact = !!(result.email || result.alternatePhone || result.whatsapp ||
    result.website || result.linkedIn || result.facebook || result.instagram ||
    result.twitter || result.youtube || (result.teamMembers?.length ?? 0) > 0)

  const hasPersona = !!(result.decisionMaker || result.decisionMakerLinkedIn ||
    (result.painPoints?.length ?? 0) > 0)

  const tabs: { id: DetailTab; label: string; icon: string }[] = [
    { id: 'business', label: 'Business Profile', icon: '🏢' },
    { id: 'persona',  label: 'Buyer Persona',    icon: '👤' },
    { id: 'contact',  label: 'Contact',           icon: '✉' },
    { id: 'social',   label: 'Social Intel',      icon: '📡' },
  ]

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-white leading-tight truncate">
            {result.lead?.companyName ?? `Lead #${result.leadId}`}
          </h2>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            {result.industry && <Chip>{result.industry}</Chip>}
            {result.companyType && <Chip>{result.companyType}</Chip>}
            {result.headquarters && <Chip>📍 {result.headquarters}</Chip>}
            {result.supplierBuyerType && <SupplierBadge type={result.supplierBuyerType} />}
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-lg border ${confColor}`}>
              {c}% confidence
            </span>
          </div>
          {result.tagline && (
            <p className="text-xs text-gray-500 italic mt-1">"{result.tagline}"</p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-colors ${
              tab === t.id
                ? 'bg-gray-700 text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'business' && <BusinessTab result={result} />}
      {tab === 'persona'  && <PersonaTab  result={result} hasData={hasPersona} />}
      {tab === 'contact'  && <ContactTab  result={result} hasData={hasContact} />}
      {tab === 'social'   && (
        <SocialIntelTab
          result={result}
          deepResearch={deepResearch}
          running={deepRunning}
          progress={deepProgress}
          error={deepError}
          onRun={handleDeepResearch}
        />
      )}

      {result.sourceUrl && (
        <div className="text-xs text-gray-700 flex items-center gap-1.5">
          <span>Source:</span>
          <a
            href={result.sourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-blue-800 hover:text-blue-600 hover:underline transition-colors"
          >
            {result.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60)}↗
          </a>
        </div>
      )}
    </div>
  )
}

// ─── Business Profile Tab ─────────────────────────────────────────────────────

function BusinessTab({ result }: { result: EnrichedResult }) {
  return (
    <div className="space-y-4">
      {result.summary && (
        <Card title="About">
          <p className="text-sm text-gray-300 leading-relaxed">{result.summary}</p>
        </Card>
      )}

      {/* Key business facts */}
      <Card title="Business Details">
        <div className="grid grid-cols-3 gap-2">
          {result.employeeCount  && <FactCell label="Team Size"       value={result.employeeCount + ' employees'} />}
          {result.annualTurnover && <FactCell label="Annual Turnover" value={result.annualTurnover} />}
          {result.yearFounded    && <FactCell label="Founded"         value={String(result.yearFounded)} />}
          {result.companyType    && <FactCell label="Legal Type"      value={result.companyType} />}
          {result.industry       && <FactCell label="Industry"        value={result.industry} />}
          {result.lead?.city     && <FactCell label="City"            value={result.lead.city} />}
          {result.lead?.keyword  && <FactCell label="Category"        value={result.lead.keyword} />}
          {result.supplierBuyerType && (
            <FactCell label="Business Type" value={SUPPLIER_LABELS[result.supplierBuyerType]} />
          )}
        </div>
      </Card>

      {/* Export markets */}
      {result.exportMarkets && result.exportMarkets.length > 0 && (
        <Card title="Export Markets">
          <div className="flex flex-wrap gap-1.5">
            {result.exportMarkets.map((m) => (
              <span key={m} className="text-xs px-2.5 py-1 bg-blue-950 border border-blue-800 text-blue-300 rounded-full font-medium">
                🌐 {m}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Current software */}
      {result.currentSoftware && result.currentSoftware.length > 0 && (
        <Card title="Current Software / ERP">
          <div className="flex flex-wrap gap-1.5">
            {result.currentSoftware.map((s) => (
              <span key={s} className="text-xs px-2.5 py-1 bg-gray-800 border border-gray-600 text-gray-300 rounded-full font-mono">
                {s}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Expansion signals */}
      {result.expansionSignals && result.expansionSignals.length > 0 && (
        <Card title="Expansion Signals">
          <ul className="space-y-1.5">
            {result.expansionSignals.map((sig, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-green-500 shrink-0 mt-0.5">↑</span>
                {sig}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Certifications */}
      {result.certifications && result.certifications.length > 0 && (
        <Card title="Certifications & Standards">
          <div className="flex flex-wrap gap-1.5">
            {result.certifications.map((cert) => (
              <span key={cert} className="text-xs px-2.5 py-1 bg-green-950 border border-green-800 text-green-300 rounded-full font-medium">
                {cert}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Major clients */}
      {result.majorClients && result.majorClients.length > 0 && (
        <Card title="Major Clients & Customers">
          <div className="flex flex-wrap gap-1.5">
            {result.majorClients.map((c) => (
              <span key={c} className="text-xs px-2.5 py-1 bg-purple-950 border border-purple-800 text-purple-300 rounded-full font-medium">
                {c}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Services */}
      {result.services && result.services.length > 0 && (
        <Card title="Services & Products">
          <div className="flex flex-wrap gap-1.5">
            {result.services.map((s) => (
              <span key={s} className="text-xs px-2.5 py-1 bg-gray-800 border border-gray-700 text-gray-300 rounded-full">
                {s}
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Buyer Persona Tab ────────────────────────────────────────────────────────

function PersonaTab({ result, hasData }: { result: EnrichedResult; hasData: boolean }) {
  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
        <div className="text-3xl opacity-30">👤</div>
        <div className="text-gray-500 text-sm">No buyer persona data found</div>
        <div className="text-gray-700 text-xs">Re-research this lead to extract decision maker details</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Decision maker */}
      <Card title="Decision Maker">
        <div className="space-y-3">
          {result.decisionMaker ? (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-purple-900 border border-purple-700 flex items-center justify-center text-sm font-bold text-purple-200 shrink-0">
                {result.decisionMaker.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-semibold text-white">{result.decisionMaker}</div>
                {result.lead?.keyword && (
                  <div className="text-xs text-gray-500">{result.lead.companyName}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-600">Decision maker not identified</div>
          )}

          {result.decisionMakerLinkedIn && (
            <div className="flex items-center justify-between gap-2 bg-gray-800/60 rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-blue-500 font-bold">in</span>
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Personal LinkedIn</div>
                  <a
                    href={result.decisionMakerLinkedIn}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors"
                  >
                    {result.decisionMakerLinkedIn.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                </div>
              </div>
              <CopyBtn value={result.decisionMakerLinkedIn} />
            </div>
          )}
        </div>
      </Card>

      {/* Pain points */}
      {result.painPoints && result.painPoints.length > 0 && (
        <Card title="Likely Pain Points">
          <div className="space-y-2">
            {result.painPoints.map((p, i) => (
              <div key={i} className="flex items-start gap-2.5 bg-orange-950/20 border border-orange-900/30 rounded-lg px-3 py-2.5">
                <span className="text-orange-500 shrink-0 text-sm mt-0.5">!</span>
                <span className="text-sm text-gray-300">{p}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-2">AI-inferred based on industry, company size, and business type</p>
        </Card>
      )}

      {/* Contact quick-access */}
      {(result.email || result.alternatePhone || result.whatsapp) && (
        <Card title="Best Ways to Reach">
          <div className="space-y-2">
            {result.alternatePhone && (
              <div className="flex items-center justify-between bg-gray-800/60 rounded-lg px-3 py-2.5">
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Phone</div>
                  <div className="text-sm text-gray-200">{result.alternatePhone}</div>
                </div>
                <CopyBtn value={result.alternatePhone} />
              </div>
            )}
            {result.whatsapp && (
              <div className="flex items-center justify-between bg-gray-800/60 rounded-lg px-3 py-2.5">
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">WhatsApp</div>
                  <div className="text-sm text-gray-200">{result.whatsapp.replace('https://wa.me/', '')}</div>
                </div>
                <CopyBtn value={result.whatsapp} />
              </div>
            )}
            {result.email && (
              <div className="flex items-center justify-between bg-gray-800/60 rounded-lg px-3 py-2.5">
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Business Email</div>
                  <div className="text-sm text-gray-200">{result.email}</div>
                </div>
                <CopyBtn value={result.email} />
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Expansion signals as buying signals */}
      {result.expansionSignals && result.expansionSignals.length > 0 && (
        <Card title="Buying Signals">
          <ul className="space-y-1.5">
            {result.expansionSignals.map((sig, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-green-500 shrink-0 mt-0.5">✓</span>
                {sig}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Current software — selling angle */}
      {result.currentSoftware && result.currentSoftware.length > 0 && (
        <Card title="Current Tech Stack">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {result.currentSoftware.map((s) => (
              <span key={s} className="text-xs px-2.5 py-1 bg-gray-800 border border-gray-600 text-gray-300 rounded-full font-mono">
                {s}
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-600">Use this to tailor your pitch — position your product as an upgrade or integration</p>
        </Card>
      )}
    </div>
  )
}

// ─── Contact Tab ──────────────────────────────────────────────────────────────

function ContactTab({ result, hasData }: { result: EnrichedResult; hasData: boolean }) {
  const socialLinks = [
    { icon: 'in', label: 'LinkedIn Company', url: result.linkedIn },
    { icon: 'f',  label: 'Facebook',         url: result.facebook },
    { icon: '▶',  label: 'YouTube',          url: result.youtube },
    { icon: '📸', label: 'Instagram',        url: result.instagram },
    { icon: '𝕏',  label: 'Twitter',          url: result.twitter },
  ].filter((s) => s.url)

  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
        <div className="text-3xl opacity-30">✉</div>
        <div className="text-gray-500 text-sm">No contact information found</div>
        <div className="text-gray-700 text-xs">Re-research this lead to extract contact details</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Primary contacts */}
      {(result.email || result.alternatePhone || result.whatsapp) && (
        <Card title="Direct Contact">
          <div className="space-y-2">
            {result.email && (
              <Row icon="✉" label="Business Email" value={result.email} copyable />
            )}
            {result.alternatePhone && (
              <Row icon="☏" label="Phone" value={result.alternatePhone} copyable />
            )}
            {result.whatsapp && (
              <Row icon="💬" label="WhatsApp" value={result.whatsapp} copyable link={result.whatsapp} />
            )}
          </div>
        </Card>
      )}

      {/* Website */}
      {result.website && (
        <Card title="Website">
          <div className="flex items-center justify-between gap-2 bg-gray-800/60 rounded-lg px-3 py-2.5">
            <a
              href={result.website}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-sm text-blue-400 hover:text-blue-300 hover:underline transition-colors truncate"
            >
              {result.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
            <CopyBtn value={result.website} />
          </div>
        </Card>
      )}

      {/* Social media */}
      {(result.decisionMakerLinkedIn || socialLinks.length > 0) && (
        <Card title="Social Media & Profiles">
          <div className="space-y-2">
            {result.decisionMakerLinkedIn && (
              <div className="flex items-center justify-between gap-2 bg-blue-950/20 border border-blue-900/30 rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-blue-500 font-bold">in</span>
                  <div>
                    <div className="text-xs text-blue-400/70 mb-0.5">Decision Maker's LinkedIn</div>
                    <a
                      href={result.decisionMakerLinkedIn}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors"
                    >
                      {result.decisionMakerLinkedIn.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    </a>
                  </div>
                </div>
                <CopyBtn value={result.decisionMakerLinkedIn} />
              </div>
            )}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {socialLinks.map(({ icon, label, url }) => (
                  <a
                    key={label}
                    href={url!}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700
                      border border-gray-700 hover:border-gray-600 rounded-lg text-xs text-gray-300
                      hover:text-white transition-colors"
                  >
                    <span className="text-gray-500">{icon}</span>
                    {label}
                    <span className="text-gray-700 text-xs">↗</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Team members */}
      {result.teamMembers && result.teamMembers.length > 0 && (
        <Card title="Team Members">
          <div className="space-y-2">
            {result.teamMembers.map((m, i) => (
              <div key={i} className="flex items-center gap-3 bg-gray-800/60 rounded-lg px-3 py-2">
                <div className="w-7 h-7 rounded-full bg-purple-900 border border-purple-800 flex items-center justify-center text-xs font-bold text-purple-300 shrink-0">
                  {m.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="text-sm text-white font-medium">{m.name}</div>
                  <div className="text-xs text-gray-500">{m.role}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Social Intel Tab ────────────────────────────────────────────────────────

const PLATFORM_STYLES: Record<string, { icon: string; bg: string; label: string }> = {
  linkedin:  { icon: 'in', bg: 'bg-blue-950/40 border-blue-800/50 text-blue-300',  label: 'LinkedIn' },
  twitter:   { icon: '𝕏',  bg: 'bg-gray-900 border-gray-700 text-gray-300',        label: 'Twitter/X' },
  facebook:  { icon: 'f',  bg: 'bg-blue-950/30 border-blue-900/40 text-blue-400',  label: 'Facebook' },
  instagram: { icon: '📸', bg: 'bg-pink-950/30 border-pink-900/40 text-pink-400',  label: 'Instagram' },
  youtube:   { icon: '▶',  bg: 'bg-red-950/30 border-red-900/40 text-red-400',     label: 'YouTube' },
  news:      { icon: '📰', bg: 'bg-orange-950/30 border-orange-900/40 text-orange-300', label: 'News' },
  web:       { icon: '🌐', bg: 'bg-gray-800 border-gray-700 text-gray-400',         label: 'Web' },
}

function SocialIntelTab({
  result, deepResearch, running, progress, error, onRun,
}: {
  result: EnrichedResult
  deepResearch: DeepResearch | null
  running: boolean
  progress: string
  error: string | null
  onRun: () => void
}) {
  const hasTeam = (result.teamMembers?.length ?? 0) > 0 || !!result.decisionMaker

  if (!deepResearch && !running) {
    return (
      <div className="space-y-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <div className="text-sm font-semibold text-white">Social Intelligence</div>
          <p className="text-xs text-gray-500 leading-relaxed">
            Opens hidden tabs in your browser to scrape real posts from{' '}
            <span className="text-blue-400">LinkedIn</span>,{' '}
            <span className="text-sky-400">Twitter/X</span>, and{' '}
            <span className="text-pink-400">Instagram</span> — using your logged-in session.
            AI then extracts intent signals and generates a personalized pitch.
          </p>
          <div className="text-xs text-gray-600 space-y-1">
            <div>Make sure you are logged into LinkedIn &amp; Twitter in this browser.</div>
            <div>People found: <span className="text-white">{result.teamMembers?.map(m => m.name).join(', ') || result.decisionMaker || 'none yet'}</span></div>
          </div>
          {!hasTeam && (
            <p className="text-xs text-yellow-600">
              No team members found yet — run Research first to identify key people.
            </p>
          )}
          {error && (
            <div className="text-xs text-red-400 bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <button
            onClick={onRun}
            disabled={running || !hasTeam}
            className="w-full py-2.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-40
              text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            📡 Run Deep Research
          </button>
          <p className="text-xs text-gray-700 text-center">
            Opens background tabs · Takes 1–3 min · Uses your OpenAI key
          </p>
        </div>
      </div>
    )
  }

  if (running) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-5">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
        <div className="text-sm text-gray-300 font-medium">Deep Research Running…</div>
        {progress && (
          <div className="text-xs text-purple-400 bg-purple-950/30 border border-purple-800/40
            rounded-lg px-4 py-2.5 max-w-xs text-center leading-relaxed">
            {progress}
          </div>
        )}
        <div className="text-xs text-gray-600 text-center max-w-xs">
          Opening background tabs for LinkedIn, Twitter, Instagram.
          <br/>Do not close the browser during this process.
        </div>
      </div>
    )
  }

  if (!deepResearch) return null

  const researchedDate = new Date(deepResearch.researchedAt).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric'
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-600">Last scanned: {researchedDate}</div>
        <button
          onClick={onRun}
          disabled={running}
          className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
        >
          Re-run
        </button>
      </div>

      {/* Recommended Pitch */}
      {deepResearch.recommendedPitch && (
        <div className="bg-green-950/20 border border-green-800/40 rounded-xl p-4 space-y-2">
          <div className="text-xs font-semibold text-green-400 uppercase tracking-wide">
            AI Recommended Pitch Angle
          </div>
          <p className="text-sm text-gray-200 leading-relaxed">{deepResearch.recommendedPitch}</p>
        </div>
      )}

      {/* Intent Signals */}
      {deepResearch.intentSignals.length > 0 && (
        <Card title="Intent Signals">
          <div className="space-y-2">
            {deepResearch.intentSignals.map((signal, i) => (
              <div key={i} className="flex items-start gap-2.5 bg-orange-950/20 border border-orange-900/30 rounded-lg px-3 py-2.5">
                <span className="text-orange-400 shrink-0 text-sm">⚡</span>
                <span className="text-sm text-gray-300">{signal}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Company Signals */}
      {deepResearch.companySignals.length > 0 && (
        <Card title="Company Activity Signals">
          <ul className="space-y-1.5">
            {deepResearch.companySignals.map((sig, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-blue-400 shrink-0 mt-0.5">→</span>
                {sig}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* People Activity */}
      {deepResearch.peopleActivity.map((person, pi) => (
        <div key={pi} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Person header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-gray-800/60 border-b border-gray-800">
            <div className="w-8 h-8 rounded-full bg-purple-900 border border-purple-700 flex items-center justify-center text-sm font-bold text-purple-200 shrink-0">
              {person.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-white">{person.name}</div>
              <div className="text-xs text-gray-500">{person.role}</div>
            </div>
            {person.linkedInUrl && (
              <a
                href={person.linkedInUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
              >
                <span className="font-bold">in</span> LinkedIn ↗
              </a>
            )}
          </div>

          <div className="p-4 space-y-3">
            {/* Topics */}
            {person.topics.length > 0 && (
              <div>
                <div className="text-xs text-gray-600 mb-1.5">Talks about</div>
                <div className="flex flex-wrap gap-1.5">
                  {person.topics.map((t, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 bg-purple-950/50 border border-purple-800/50 text-purple-300 rounded-full">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Activity summary */}
            {person.activitySummary && (
              <p className="text-xs text-gray-400 leading-relaxed">{person.activitySummary}</p>
            )}

            {/* Best approach */}
            {person.bestApproach && (
              <div className="bg-blue-950/20 border border-blue-900/30 rounded-lg px-3 py-2.5">
                <div className="text-xs text-blue-400 font-medium mb-1">Best approach for {person.name.split(' ')[0]}</div>
                <p className="text-xs text-gray-300">{person.bestApproach}</p>
              </div>
            )}

            {/* Recent posts */}
            {person.posts.length > 0 ? (
              <div>
                <div className="text-xs text-gray-600 mb-2">Recent posts & mentions</div>
                <div className="space-y-2">
                  {person.posts.slice(0, 6).map((post, i) => {
                    const style = PLATFORM_STYLES[post.platform] ?? PLATFORM_STYLES.web
                    return (
                      <div key={i} className={`rounded-lg border px-3 py-2.5 space-y-1 ${style.bg}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold opacity-80">{style.icon}</span>
                          <span className="text-xs opacity-70">{style.label}</span>
                          {post.date && <span className="text-xs opacity-50 ml-auto">{post.date}</span>}
                        </div>
                        {post.headline && (
                          <div className="text-xs font-medium text-white/90">{post.headline}</div>
                        )}
                        <p className="text-xs leading-relaxed">{post.snippet}</p>
                        {post.url && (
                          <a
                            href={post.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs opacity-50 hover:opacity-80 underline transition-opacity block truncate"
                          >
                            {post.url.replace(/^https?:\/\//, '').slice(0, 60)}↗
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-700 py-2">No public posts found in the last 6 months</div>
            )}
          </div>
        </div>
      ))}

      {/* Pitch Template */}
      {deepResearch.pitchTemplate && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Ready-to-Send Pitch Template
            </div>
            <CopyBtn value={deepResearch.pitchTemplate} />
          </div>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
            {deepResearch.pitchTemplate}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Shared components ────────────────────────────────────────────────────────

const SUPPLIER_LABELS: Record<string, string> = {
  manufacturer:     'Manufacturer',
  trader:           'Trader',
  distributor:      'Distributor',
  service_provider: 'Service Provider',
  mixed:            'Manufacturer + Trader',
}

const SUPPLIER_COLORS: Record<string, string> = {
  manufacturer:     'bg-blue-950 border-blue-800 text-blue-300',
  trader:           'bg-yellow-950 border-yellow-800 text-yellow-300',
  distributor:      'bg-teal-950 border-teal-800 text-teal-300',
  service_provider: 'bg-purple-950 border-purple-800 text-purple-300',
  mixed:            'bg-gray-800 border-gray-700 text-gray-300',
}

function SupplierBadge({ type }: { type: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${SUPPLIER_COLORS[type] ?? 'bg-gray-800 border-gray-700 text-gray-300'}`}>
      {SUPPLIER_LABELS[type] ?? type}
    </span>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{title}</div>
      {children}
    </div>
  )
}

function Row({ icon, label, value, copyable, link }: {
  icon: string; label: string; value: string; copyable?: boolean; link?: string
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-600 text-xs mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-500 mb-0.5">{label}</div>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm text-blue-400 hover:text-blue-300 hover:underline transition-colors break-all"
          >
            {value}
          </a>
        ) : (
          <div className="text-sm text-gray-200 break-all">{value}</div>
        )}
      </div>
      {copyable && <CopyBtn value={value} />}
    </div>
  )
}

function FactCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800 rounded-lg px-3 py-2">
      <div className="text-xs text-gray-600 mb-0.5">{label}</div>
      <div className="text-sm text-gray-200 font-medium">{value}</div>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs px-2 py-0.5 bg-gray-800 border border-gray-700 text-gray-400 rounded-full">
      {children}
    </span>
  )
}
