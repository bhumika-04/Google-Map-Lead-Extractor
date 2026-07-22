import React, { useEffect, useState } from 'react'
import { MSG } from '@/types/messages'
import type { BatchCampaign, BatchCampaignCity } from '@/types/batchCampaign'
import { createCampaign, getAllCampaigns, deleteCampaign } from '@/services/batchCampaignService'
import { toast } from '@/state/useToastStore'
import { useSettingsStore } from '@/state/useSettingsStore'
import { timeAgo } from '@/utils/date'
import { COUNTRIES, flag, CityMultiSelect } from './SearchConsole'
import { fetchTopCities } from '@/services/cityService'

export default function BatchCampaignPanel() {
  const [campaigns, setCampaigns] = useState<BatchCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null)

  const { settings } = useSettingsStore()

  // Form state — a campaign can now span multiple countries. `entries` is the
  // full {city, country} list; `country` is just the country currently being
  // added to via the picker below.
  const [keyword, setKeyword] = useState('')
  const [entries, setEntries] = useState<{ city: string; country: string }[]>([])
  const [country, setCountry] = useState(settings.lastCountry || 'IN')
  const [fetchingTier, setFetchingTier] = useState<number | null>(null)
  const [autoResearch, setAutoResearch] = useState(false)
  const [showForm, setShowForm] = useState(false)

  // Follow Search Console's last-used country once settings load
  useEffect(() => {
    if (settings.lastCountry) setCountry(settings.lastCountry)
  }, [settings.lastCountry])

  // Auto-validation runs from the background service worker once the whole
  // campaign completes (see advanceBatchCampaign in serviceWorker.ts), so it fires
  // even if this page isn't open — this panel only needs to poll for display state.
  async function refresh() {
    const all = await getAllCampaigns()
    setCampaigns(all)
    setLoading(false)
    // Check if any campaign is currently running
    const running = all.find(c => c.status === 'running')
    setActiveCampaignId(running?.id ?? null)
  }

  useEffect(() => {
    refresh()
    // Poll every 3 seconds to update city progress
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [])

  // Cities chosen for the CURRENTLY-selected country (derived from the full list)
  const currentCities = entries.filter(e => e.country === country).map(e => e.city)
  function setCurrentCities(cs: string[]) {
    setEntries([
      ...entries.filter(e => e.country !== country),
      ...cs.map(city => ({ city, country })),
    ])
  }

  // Dynamic AI quick-add for the current country — works for any country.
  async function addTopCities(n: number) {
    if (fetchingTier !== null) return
    const countryName = COUNTRIES.find(c => c.code === country)?.name ?? country
    setFetchingTier(n)
    try {
      const cities = await fetchTopCities(country, countryName, n, settings)
      if (!cities.length) { toast.error(`No cities returned for ${countryName}`); return }
      setCurrentCities([...new Set([...currentCities, ...cities])])
      toast.success(`Added ${cities.length} top ${countryName} cities`)
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not fetch cities')
    } finally {
      setFetchingTier(null)
    }
  }

  const countryCount = new Set(entries.map(e => e.country)).size

  async function handleStart() {
    if (!keyword.trim()) { toast.error('Enter a keyword'); return }
    if (entries.length < 2) { toast.error('Add at least 2 cities'); return }
    if (activeCampaignId !== null) { toast.error('A campaign is already running — stop it first'); return }

    setStarting(true)
    try {
      // Two-step: persist the campaign to IndexedDB first so the service worker
      // can load it by ID. The service worker only receives the ID, never the full
      // object — this avoids large payloads crossing the message boundary and ensures
      // the campaign survives a service worker restart mid-run.
      const campaignId = await createCampaign({
        keyword: keyword.trim(),
        cities: entries.map(e => ({
          city: e.city,
          country: e.country,          // per-city country → multi-country campaigns
          status: 'pending',
          capturedCount: 0,
        })),
        country: entries[0]?.country ?? country,   // primary country (session default)
        autoResearch,
      })

      const res: any = await chrome.runtime.sendMessage({
        type: MSG.BATCH_CAMPAIGN_START,
        payload: { campaignId },
      })

      if (res?.ok) {
        toast.success(`Campaign started — ${entries.length} cities queued`)
        setShowForm(false)
        setKeyword('')
        setEntries([])
        await refresh()
      } else {
        toast.error(res?.error ?? 'Failed to start campaign')
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not start campaign')
    } finally {
      setStarting(false)
    }
  }

  async function handleStop() {
    await chrome.runtime.sendMessage({ type: MSG.BATCH_CAMPAIGN_STOP })
    toast.info('Campaign stop requested — finishing current city')
    await refresh()
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this campaign record?')) return
    await deleteCampaign(id)
    toast.success('Campaign deleted')
    await refresh()
  }

  const cities = entries

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Multi-City Batch Campaigns</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Search one keyword across many cities — and now across multiple countries — automatically. Maps opens, captures, closes, moves to the next city.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {activeCampaignId !== null && (
            <button
              onClick={handleStop}
              className="text-xs px-3 py-1.5 bg-red-900 hover:bg-red-800 text-red-200 rounded-lg transition-colors"
            >
              Stop Campaign
            </button>
          )}
          {activeCampaignId === null && (
            <button
              onClick={() => setShowForm(v => !v)}
              className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              {showForm ? 'Cancel' : '+ New Campaign'}
            </button>
          )}
        </div>
      </div>

      {/* New campaign form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white">Configure Campaign</h3>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="text-xs text-gray-400 block mb-1.5">Keyword (what to search)</label>
              <input
                type="text"
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                placeholder="e.g. Packaging manufacturers"
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                  focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>

            {/* Country + cities — pick cities per country, across as many countries as you like */}
            <div className="col-span-2 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1.5">Country</label>
                  <select
                    value={country}
                    onChange={e => setCountry(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500"
                  >
                    {COUNTRIES.map(c => (
                      <option key={c.code} value={c.code}>{flag(c.code)} {c.name}</option>
                    ))}
                  </select>
                  <div className="text-xs text-gray-600 mt-1">Switch country and keep adding — each city is stamped with its own country.</div>
                </div>

                <div className="sm:col-span-2">
                  <label className="text-xs text-gray-400 block mb-1.5">
                    Cities in {COUNTRIES.find(c => c.code === country)?.name ?? country}
                  </label>
                  <CityMultiSelect
                    selected={currentCities}
                    onChange={setCurrentCities}
                    country={country}
                  />
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] text-gray-500">AI quick-add:</span>
                    {[50, 100, 200, 500].map(n => (
                      <button
                        key={n}
                        type="button"
                        disabled={fetchingTier !== null}
                        onClick={() => addTopCities(n)}
                        className="text-xs px-2.5 py-1 rounded-full text-gray-300 border border-gray-700 bg-gray-800/60
                          hover:border-indigo-500/50 hover:text-indigo-200 transition-all active:scale-95
                          disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                      >
                        {fetchingTier === n && (
                          <span className="inline-block w-3 h-3 border-2 border-indigo-400/40 border-t-indigo-400 rounded-full animate-spin" />
                        )}
                        Top {n}
                      </button>
                    ))}
                    {fetchingTier !== null && (
                      <span className="text-[11px] text-gray-500 animate-pulse">Asking AI…</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Accumulated cities across all countries */}
              {entries.length > 0 && (
                <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400 font-medium">
                      {entries.length} cities · {countryCount} countr{countryCount === 1 ? 'y' : 'ies'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEntries([])}
                      className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-40 overflow-auto">
                    {entries.map((e, i) => (
                      <span
                        key={`${e.country}-${e.city}-${i}`}
                        className="text-xs px-2 py-0.5 bg-blue-950 border border-blue-800 text-blue-300 rounded-full inline-flex items-center gap-1"
                      >
                        {flag(e.country)} {e.city}
                        <button
                          type="button"
                          onClick={() => setEntries(entries.filter((_, j) => j !== i))}
                          className="text-blue-400 hover:text-white leading-none"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoResearch}
                  onChange={e => setAutoResearch(e.target.checked)}
                  className="accent-purple-500 w-4 h-4"
                />
                <div>
                  <div className="text-xs text-gray-300 font-medium">Auto-Research</div>
                  <div className="text-xs text-gray-600">Queue each lead for AI research</div>
                </div>
              </label>
            </div>
          </div>

          {/* AI key warning */}
          {autoResearch && !settings.geminiApiKey && !settings.openAiApiKey && !settings.anthropicApiKey && (
            <div className="flex items-start gap-2 bg-yellow-950/40 border border-yellow-800/40 rounded-lg px-3 py-2.5 text-xs text-yellow-300">
              <span className="shrink-0 mt-0.5">⚠</span>
              No AI key set — auto-research will be skipped. Add one in Settings → AI Research.
            </div>
          )}

          {/* Estimated time */}
          {cities.length > 0 && (
            <div className="text-xs text-gray-600 bg-gray-800 rounded-lg px-3 py-2">
              Estimated: ~{Math.round(cities.length * 3)} – {Math.round(cities.length * 6)} minutes
              &nbsp;·&nbsp; Captures every result Maps returns per city
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleStart}
              disabled={starting || !keyword.trim() || cities.length < 2}
              className="flex-1 text-sm px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white
                rounded-lg transition-colors font-medium"
            >
              {starting ? 'Starting…' : `▶ Start Campaign (${cities.length} cities)`}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-sm px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Campaign list */}
      <div className="flex-1 overflow-auto space-y-3">
        {loading ? (
          <div className="space-y-2">
            {[1,2].map(i => <div key={i} className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />)}
          </div>
        ) : campaigns.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-700 bg-gray-900 border border-gray-800 rounded-xl">
            <div className="text-4xl mb-2 opacity-30">⊞</div>
            <div className="text-sm text-gray-500">No campaigns yet</div>
            <button
              onClick={() => setShowForm(true)}
              className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              Create your first multi-city campaign →
            </button>
          </div>
        ) : (
          campaigns.map(campaign => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              onDelete={() => handleDelete(campaign.id!)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function CampaignCard({ campaign, onDelete }: { campaign: BatchCampaign; onDelete: () => void }) {
  const isRunning = campaign.status === 'running'
  const done = campaign.cities.filter(c => c.status === 'completed').length
  const total = campaign.cities.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const statusColor =
    campaign.status === 'running'   ? 'text-blue-400 border-blue-800/60 bg-blue-950/20' :
    campaign.status === 'completed' ? 'text-green-400 border-green-800/60 bg-green-950/10' :
    campaign.status === 'stopped'   ? 'text-yellow-400 border-yellow-800/60 bg-yellow-950/10' :
    'text-gray-500 border-gray-800 bg-gray-900'

  return (
    <div className={`border rounded-xl p-4 space-y-3 ${statusColor}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {isRunning && <span className="text-blue-400 animate-pulse text-sm">●</span>}
            <span className="text-sm font-semibold text-white">{campaign.keyword}</span>
            {Array.from(new Set(campaign.cities.map(c => c.country ?? campaign.country)))
              .filter(Boolean)
              .slice(0, 6)
              .map((cc) => (
                <span key={cc} className="text-xs" title={cc as string}>{flag(cc as string)}</span>
              ))}
            <span className="text-xs text-gray-500">{total} cities</span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {campaign.totalCaptured} leads captured · Started {timeAgo(campaign.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full border capitalize
            ${campaign.status === 'running'   ? 'text-blue-400 border-blue-700 bg-blue-950/40' :
              campaign.status === 'completed' ? 'text-green-400 border-green-700 bg-green-950/40' :
              campaign.status === 'stopped'   ? 'text-yellow-400 border-yellow-700 bg-yellow-950/40' :
              'text-gray-500 border-gray-700 bg-gray-800'}`}
          >
            {campaign.status}
          </span>
          {campaign.status !== 'running' && (
            <button
              onClick={onDelete}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors"
              title="Delete"
            >×</button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>{done} of {total} cities</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isRunning ? 'bg-blue-500' : 'bg-green-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* City status grid */}
      <div className="flex flex-wrap gap-1.5">
        {campaign.cities.map((c, i) => (
          <CityChip key={i} city={c} isCurrent={isRunning && i === campaign.currentCityIndex} />
        ))}
      </div>
    </div>
  )
}

function CityChip({ city, isCurrent }: { city: BatchCampaignCity; isCurrent: boolean }) {
  const cls =
    isCurrent                    ? 'bg-blue-950 border-blue-600 text-blue-300 animate-pulse' :
    city.status === 'completed'  ? 'bg-green-950/40 border-green-800 text-green-400' :
    city.status === 'failed'     ? 'bg-red-950/40 border-red-800 text-red-400' :
    'bg-gray-800 border-gray-700 text-gray-500'

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border flex items-center gap-1 ${cls}`}>
      {isCurrent && <span className="text-blue-400">●</span>}
      {city.status === 'completed' && <span>✓</span>}
      {city.country && <span>{flag(city.country)}</span>}
      {city.city}
      {city.status === 'completed' && city.capturedCount > 0 && (
        <span className="text-green-600">({city.capturedCount})</span>
      )}
    </span>
  )
}
