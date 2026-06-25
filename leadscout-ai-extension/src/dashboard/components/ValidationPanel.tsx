import React, { useState } from 'react'
import { useSettingsStore } from '@/state/useSettingsStore'
import { useLeadStore } from '@/state/useLeadStore'
import { leadRepository } from '@/db/leadRepository'
import { validateLeads, DailyQuotaExhaustedError, type ValidationResult, type ValidationProvider } from '@/services/leadValidationService'
import { toast } from '@/state/useToastStore'

type State = 'idle' | 'running' | 'done' | 'quota_exhausted'

interface ResultItem extends ValidationResult {
  companyName: string
  category: string
  city: string
}

const PROVIDER_LABELS: Record<ValidationProvider, string> = {
  gemini:    'Gemini',
  openai:    'OpenAI',
  anthropic: 'Anthropic',
}

const PROVIDER_BADGE_STYLE: Record<ValidationProvider, string> = {
  gemini:    'bg-blue-900 text-blue-300 border-blue-800',
  openai:    'bg-green-900 text-green-300 border-green-800',
  anthropic: 'bg-purple-900 text-purple-300 border-purple-800',
}

const SETTINGS_PATH: Record<ValidationProvider, string> = {
  gemini:    'Settings → AI Research → Gemini',
  openai:    'Settings → AI Research → OpenAI',
  anthropic: 'Settings → AI Research → Anthropic',
}

export default function ValidationPanel() {
  const { settings } = useSettingsStore()
  const { loadLeads } = useLeadStore()

  const [state, setState]         = useState<State>('idle')
  const [progress, setProgress]   = useState({ done: 0, total: 0 })
  const [results, setResults]     = useState<ResultItem[]>([])
  const [activeTab, setActiveTab] = useState<'relevant' | 'not_relevant'>('relevant')
  const [confirmed, setConfirmed] = useState(false)

  const provider = settings.researchProvider as ValidationProvider
  const apiKey =
    provider === 'openai'    ? settings.openAiApiKey :
    provider === 'anthropic' ? settings.anthropicApiKey :
    settings.geminiApiKey

  const hasProfile = !!settings.businessProfile.trim()
  const hasKey     = !!apiKey.trim()

  const relevant    = results.filter((r) => r.relevant)
  const notRelevant = results.filter((r) => !r.relevant)

  async function handleValidate() {
    if (!hasProfile) { toast.warning('Set your Business Profile in Settings first'); return }
    if (!hasKey)     { toast.warning(`Add an API key in ${SETTINGS_PATH[provider]}`); return }

    const allLeads = await leadRepository.getAll()
    if (allLeads.length === 0) { toast.warning('No leads in database to validate'); return }

    setState('running')
    setProgress({ done: 0, total: allLeads.length })
    setResults([])
    setConfirmed(false)

    const leadMap = new Map(allLeads.map((l) => [l.id!, l]))
    const allResults: ResultItem[] = []

    try {
      await validateLeads(
        allLeads,
        settings.businessProfile,
        apiKey,
        provider,
        (done, total, batch) => {
          setProgress({ done, total })
          setResults((prev) => {
            const next = [...prev]
            for (const r of batch) {
              const lead = leadMap.get(r.leadId)
              if (lead) {
                const item: ResultItem = {
                  ...r,
                  companyName: lead.companyName,
                  category:    lead.category ?? lead.keyword ?? '',
                  city:        lead.city,
                }
                next.push(item)
                allResults.push(item)
              }
            }
            return next
          })
        }
      )
      const relevantCount = allResults.filter((r) => r.relevant).length
      setState('done')
      toast.success(`Validation complete — ${relevantCount} relevant leads found`)
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) {
        setState('quota_exhausted')
        toast.error('Daily API quota exhausted — try again tomorrow')
        return
      }
      setState('idle')
      toast.error('Validation failed — check console for details')
    }
  }

  async function handleConfirm() {
    if (relevant.length === 0) return
    await leadRepository.bulkUpdateValidation([
      ...relevant.map((r)    => ({ id: r.leadId, status: 'relevant'     as const, reason: r.reason })),
      ...notRelevant.map((r) => ({ id: r.leadId, status: 'not_relevant' as const, reason: r.reason })),
    ])
    const relevantIds = relevant.map((r) => r.leadId)
    await leadRepository.updateMany(relevantIds, { status: 'selected' })
    await loadLeads({ status: 'selected' })
    setConfirmed(true)
    toast.success(`${relevant.length} leads added to Selected Leads`)
  }

  async function handleReset() {
    setState('idle')
    setResults([])
    setProgress({ done: 0, total: 0 })
    setConfirmed(false)
  }

  const providerLabel = PROVIDER_LABELS[provider]
  const badgeStyle    = PROVIDER_BADGE_STYLE[provider]

  // ── Daily quota exhausted state ─────────────────────────────────────────────
  if (state === 'quota_exhausted') {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-white text-sm">AI Lead Validation</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full border ${badgeStyle}`}>{providerLabel}</span>
        </div>
        <div className="bg-red-950/50 border border-red-800/50 rounded-lg p-4 space-y-2">
          <div className="text-red-400 font-semibold text-sm">Daily API Quota Exhausted</div>
          <p className="text-xs text-red-300/80 leading-relaxed">
            Your {providerLabel} API free tier daily limit has been reached. Validation will resume after the quota resets.
          </p>
          <div className="text-xs text-gray-500 space-y-1 pt-1">
            <div>Options:</div>
            <div>• Wait until tomorrow (quota resets daily)</div>
            <div>• Upgrade to a paid API plan</div>
            <div>• Switch to a different AI provider in Settings</div>
          </div>
        </div>
        <button
          onClick={handleReset}
          className="w-full py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors"
        >
          Back
        </button>
      </div>
    )
  }

  // ── Idle state ──────────────────────────────────────────────────────────────
  if (state === 'idle') {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-white text-sm">AI Lead Validation</h3>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${badgeStyle}`}>{providerLabel}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Automatically validate all leads in your database against your business profile.
              Relevant leads are added here; irrelevant ones are tagged "Not Relevant" in Lead Database.
            </p>
          </div>
        </div>

        {hasProfile ? (
          <div className="bg-gray-800 rounded-lg px-3 py-2.5 space-y-1">
            <div className="text-xs text-gray-500 font-medium">Your Business Profile</div>
            <p className="text-xs text-gray-300 leading-relaxed line-clamp-3">{settings.businessProfile}</p>
            <a href="#settings" className="text-xs text-blue-400 hover:text-blue-300">Edit in Settings →</a>
          </div>
        ) : (
          <div className="bg-yellow-950/40 border border-yellow-800/40 rounded-lg px-3 py-2.5 text-xs text-yellow-300">
            No business profile set. Go to <strong>Settings → My Business Profile</strong> and describe your business first.
          </div>
        )}

        {!hasKey && (
          <div className="bg-orange-950/40 border border-orange-800/40 rounded-lg px-3 py-2.5 text-xs text-orange-300">
            {providerLabel} API key required. Go to <strong>{SETTINGS_PATH[provider]}</strong> and add your key.
          </div>
        )}

        <button
          onClick={handleValidate}
          disabled={!hasProfile || !hasKey}
          className="w-full py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed
            text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Validate All Leads from Database
        </button>
      </div>
    )
  }

  // ── Running state ───────────────────────────────────────────────────────────
  if (state === 'running') {
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
    const liveRelevant    = results.filter((r) => r.relevant).length
    const liveNotRelevant = results.filter((r) => !r.relevant).length

    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white text-sm flex items-center gap-2">
            <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
            Validating leads…
          </h3>
          <span className="text-xs text-gray-400">{progress.done} / {progress.total}</span>
        </div>

        <div className="space-y-1.5">
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>{pct}% complete</span>
            <span className="text-green-400">{liveRelevant} relevant</span>
            <span className="text-gray-500">{liveNotRelevant} not relevant</span>
          </div>
        </div>

        {results.length > 0 && (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {[...results].reverse().slice(0, 20).map((r) => (
              <div key={r.leadId} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                r.relevant ? 'bg-green-950/30 border border-green-900/40' : 'bg-gray-800/60 border border-gray-700/40'
              }`}>
                <span className={`shrink-0 mt-0.5 font-bold ${r.relevant ? 'text-green-400' : 'text-gray-600'}`}>
                  {r.relevant ? '✓' : '✕'}
                </span>
                <div className="flex-1 min-w-0">
                  <span className={`font-medium ${r.relevant ? 'text-green-200' : 'text-gray-400'}`}>{r.companyName}</span>
                  <span className="text-gray-600 mx-1">·</span>
                  <span className="text-gray-500">{r.reason}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Done state ──────────────────────────────────────────────────────────────
  const displayed = activeTab === 'relevant' ? relevant : notRelevant

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold text-white text-sm">Validation Complete</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {results.length} leads evaluated · {relevant.length} relevant · {notRelevant.length} not relevant
          </p>
        </div>
        <button onClick={handleReset} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
          Re-run
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-green-950/40 border border-green-900/40 rounded-lg px-3 py-2.5 text-center">
          <div className="text-2xl font-bold text-green-400">{relevant.length}</div>
          <div className="text-xs text-green-300/70 mt-0.5">Relevant Leads</div>
        </div>
        <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-center">
          <div className="text-2xl font-bold text-gray-400">{notRelevant.length}</div>
          <div className="text-xs text-gray-500 mt-0.5">Not Relevant</div>
        </div>
      </div>

      {!confirmed ? (
        <button
          onClick={handleConfirm}
          disabled={relevant.length === 0}
          className="w-full py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-40
            text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Add {relevant.length} Relevant Leads to Selected
        </button>
      ) : (
        <div className="flex items-center gap-2 bg-green-950/30 border border-green-900/40 rounded-lg px-3 py-2.5 text-xs text-green-300">
          <span>✓</span>
          <span>{relevant.length} leads added to Selected Leads · {notRelevant.length} tagged "Not Relevant" in Lead Database</span>
        </div>
      )}

      <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
        {(['relevant', 'not_relevant'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === tab
                ? tab === 'relevant'
                  ? 'bg-green-800 text-green-100'
                  : 'bg-gray-700 text-gray-200'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab === 'relevant' ? `Relevant (${relevant.length})` : `Not Relevant (${notRelevant.length})`}
          </button>
        ))}
      </div>

      <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        {displayed.length === 0 && (
          <div className="text-center text-xs text-gray-600 py-4">No leads in this category</div>
        )}
        {displayed.map((r) => (
          <div
            key={r.leadId}
            className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 border ${
              r.relevant
                ? 'bg-green-950/20 border-green-900/30'
                : 'bg-gray-800/60 border-gray-700/40'
            }`}
          >
            <span className={`shrink-0 text-sm mt-0.5 ${r.relevant ? 'text-green-400' : 'text-gray-600'}`}>
              {r.relevant ? '✓' : '✕'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={`text-sm font-medium ${r.relevant ? 'text-white' : 'text-gray-400'}`}>
                  {r.companyName}
                </span>
                {r.category && (
                  <span className="text-xs text-gray-600">{r.category}</span>
                )}
                <span className={`text-xs ml-auto shrink-0 ${r.confidence >= 0.8 ? 'text-gray-500' : 'text-gray-700'}`}>
                  {Math.round(r.confidence * 100)}%
                </span>
              </div>
              <div className={`text-xs mt-0.5 ${r.relevant ? 'text-green-300/80' : 'text-gray-500'}`}>
                {r.reason}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
