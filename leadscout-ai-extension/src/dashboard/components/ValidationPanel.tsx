import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '@/state/useSettingsStore'
import { useLeadStore } from '@/state/useLeadStore'
import { leadRepository } from '@/db/leadRepository'
import { validateLeads, DailyQuotaExhaustedError, type ValidationResult, type ValidationProvider } from '@/services/leadValidationService'
import { saveValidationBulkToSql, resolveAiCredentials, saveBusinessProfile } from '@/services/sqlSyncService'
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
  const { settings, load: reloadSettings } = useSettingsStore()
  const { loadLeads, projectScope } = useLeadStore()

  // Business Profile editing — persists to appsettings.json's App:BusinessProfile
  // via the DeepLead API (the extension has no local storage for this field).
  const [editingProfile, setEditingProfile] = useState(false)
  const [profileDraft, setProfileDraft]     = useState(settings.businessProfile)
  const [savingProfile, setSavingProfile]   = useState(false)

  useEffect(() => {
    if (!editingProfile) setProfileDraft(settings.businessProfile)
  }, [settings.businessProfile, editingProfile])

  async function handleSaveProfile() {
    setSavingProfile(true)
    const ok = await saveBusinessProfile(profileDraft.trim())
    setSavingProfile(false)
    if (ok) {
      toast.success('Business profile saved')
      setEditingProfile(false)
      await reloadSettings()
    } else {
      toast.error('Failed to save — is the DeepLead API running?')
    }
  }

  const [state, setState]         = useState<State>('idle')
  const [progress, setProgress]   = useState({ done: 0, total: 0 })
  const [results, setResults]     = useState<ResultItem[]>([])
  const [activeTab, setActiveTab] = useState<'relevant' | 'not_relevant'>('relevant')
  const [confirmed, setConfirmed] = useState(false)

  // Resolved from backend appsettings.json
  const [creds, setCreds] = useState<{ provider: ValidationProvider; apiKey: string }>({
    provider: settings.researchProvider as ValidationProvider,
    apiKey:
      settings.researchProvider === 'openai'    ? settings.openAiApiKey :
      settings.researchProvider === 'anthropic' ? settings.anthropicApiKey :
      settings.geminiApiKey,
  })

  useEffect(() => {
    let cancelled = false
    resolveAiCredentials(settings).then((resolved) => {
      if (!cancelled) setCreds(resolved)
    })
    return () => { cancelled = true }
  }, [settings.researchProvider, settings.geminiApiKey, settings.openAiApiKey, settings.anthropicApiKey])

  // Local overrides — let user switch provider/key without touching appsettings.json
  const [providerOverride, setProviderOverride] = useState<ValidationProvider | null>(null)
  const [keyOverride, setKeyOverride]           = useState('')

  const provider = providerOverride ?? creds.provider
  const apiKey   = providerOverride
    ? (keyOverride.trim() || (
        providerOverride === 'openai'    ? settings.openAiApiKey :
        providerOverride === 'anthropic' ? settings.anthropicApiKey :
        settings.geminiApiKey
      ))
    : creds.apiKey

  function handleSwitchProvider(p: ValidationProvider) {
    setProviderOverride(p)
    setKeyOverride('')
    setState('idle')
  }

  const hasProfile = !!settings.businessProfile.trim()
  const hasKey     = !!apiKey.trim()

  const relevant    = results.filter((r) => r.relevant)
  const notRelevant = results.filter((r) => !r.relevant)

  async function handleValidate() {
    if (!hasProfile) { toast.warning('Set your Business Profile in Settings first'); return }
    if (!hasKey)     { toast.warning(`Add an API key in ${SETTINGS_PATH[provider]}`); return }

    // Respect the active Search Session scope — validate only this session's
    // leads, not the entire database.
    const allLeads = projectScope
      ? await leadRepository.getByFilter({ projectId: projectScope.id })
      : await leadRepository.getAll()
    if (allLeads.length === 0) {
      toast.warning(projectScope ? `No leads in session "${projectScope.name}" to validate` : 'No leads in database to validate')
      return
    }

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

    // 1. Update IndexedDB (source of truth for UI state)
    await leadRepository.bulkUpdateValidation([
      ...relevant.map((r)    => ({ id: r.leadId, status: 'relevant'     as const, reason: r.reason })),
      ...notRelevant.map((r) => ({ id: r.leadId, status: 'not_relevant' as const, reason: r.reason })),
    ])
    const relevantIds = relevant.map((r) => r.leadId)
    await leadRepository.updateMany(relevantIds, { status: 'selected' })

    // 2. Persist to MSSQL so Selected Leads survive extension reinstall
    const allLeads = await Promise.all(
      [...relevant.map(r => r.leadId), ...notRelevant.map(r => r.leadId)]
        .map(id => leadRepository.getById(id))
    )
    const relevantIdSet = new Set(relevantIds)
    const mssqlUpdates = allLeads
      .filter((l): l is NonNullable<typeof l> => !!l?.mssqlId)
      .map(l => ({
        mssqlId: l.mssqlId!,
        status:  relevantIdSet.has(l.id!) ? 'selected' as const : 'not_relevant' as const,
      }))
    saveValidationBulkToSql(mssqlUpdates).catch(() => {})   // fire-and-forget

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
          <div className="text-red-400 font-semibold text-sm">
            {providerLabel} Credits Exhausted
          </div>
          <p className="text-xs text-red-300/80 leading-relaxed">
            Your {providerLabel} quota or prepayment credits are depleted. Switch to another provider to continue.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-gray-500">Switch provider and retry:</div>
          <div className="flex gap-2">
            {(['openai', 'anthropic', 'gemini'] as ValidationProvider[]).filter(p => p !== provider).map((p) => (
              <button
                key={p}
                onClick={() => handleSwitchProvider(p)}
                className={`flex-1 py-2 text-xs rounded-lg border font-semibold transition-colors ${PROVIDER_BADGE_STYLE[p]}`}
              >
                Switch to {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
          {providerOverride && !apiKey.trim() && (
            <input
              type="password"
              placeholder={`${PROVIDER_LABELS[providerOverride]} API key`}
              value={keyOverride}
              onChange={(e) => setKeyOverride(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-3 py-2
                placeholder-gray-600 focus:outline-none focus:border-blue-600"
            />
          )}
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
    const allProviders: ValidationProvider[] = ['gemini', 'openai', 'anthropic']

    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-white text-sm">AI Lead Validation</h3>
            <p className="text-xs text-gray-500 mt-1">
              {projectScope
                ? <>Validates leads in session <span className="text-purple-300 font-medium">◈ {projectScope.name}</span> against your business profile.</>
                : <>Validates all leads against your business profile.</>}
              {' '}Relevant leads are added here; irrelevant ones are tagged "Not Relevant".
            </p>
          </div>
        </div>

        {/* Provider selector */}
        <div className="space-y-2">
          <div className="text-xs text-gray-500 font-medium">AI Provider</div>
          <div className="flex gap-2">
            {allProviders.map((p) => (
              <button
                key={p}
                onClick={() => handleSwitchProvider(p)}
                className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors ${
                  provider === p
                    ? PROVIDER_BADGE_STYLE[p] + ' font-semibold'
                    : 'border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
                }`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
          {/* Key input — shown when override active and no key already configured */}
          {providerOverride && !apiKey.trim() && (
            <input
              type="password"
              placeholder={`${PROVIDER_LABELS[providerOverride]} API key`}
              value={keyOverride}
              onChange={(e) => setKeyOverride(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-3 py-2
                placeholder-gray-600 focus:outline-none focus:border-blue-600"
            />
          )}
        </div>

        {/* Business Profile — editable, persists to appsettings.json via the API */}
        <div className="bg-gray-800 rounded-lg px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-500 font-medium">Your Business Profile</div>
            {!editingProfile && (
              <button
                onClick={() => { setProfileDraft(settings.businessProfile); setEditingProfile(true) }}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Edit
              </button>
            )}
          </div>

          {editingProfile ? (
            <div className="space-y-2">
              <textarea
                value={profileDraft}
                onChange={(e) => setProfileDraft(e.target.value)}
                rows={8}
                className="w-full bg-gray-900 border border-gray-700 text-white text-xs rounded-lg px-3 py-2
                  leading-relaxed focus:outline-none focus:border-blue-600 resize-y font-mono"
                placeholder="Describe your product/ICP — this becomes the MY BUSINESS section of the validation prompt."
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveProfile}
                  disabled={savingProfile || !profileDraft.trim()}
                  className="flex-1 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  {savingProfile ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => { setEditingProfile(false); setProfileDraft(settings.businessProfile) }}
                  disabled={savingProfile}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
              <div className="text-xs text-gray-600">Saved to appsettings.json — no API restart needed.</div>
            </div>
          ) : hasProfile ? (
            <p className="text-xs text-gray-300 leading-relaxed line-clamp-3">{settings.businessProfile}</p>
          ) : (
            <p className="text-xs text-yellow-300">No business profile set — click Edit to add one.</p>
          )}
        </div>

        {!hasKey && (
          <div className="bg-orange-950/40 border border-orange-800/40 rounded-lg px-3 py-2.5 text-xs text-orange-300">
            {providerLabel} API key not configured. Add it to <strong>appsettings.json</strong> or enter it above.
          </div>
        )}

        <button
          onClick={handleValidate}
          disabled={!hasProfile || !hasKey}
          className="w-full py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed
            text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Validate All Leads with {providerLabel}
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
