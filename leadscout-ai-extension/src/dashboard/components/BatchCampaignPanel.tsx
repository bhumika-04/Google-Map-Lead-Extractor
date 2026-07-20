import React, { useEffect, useState } from 'react'
import { MSG } from '@/types/messages'
import type { BatchCampaign, BatchCampaignCity } from '@/types/batchCampaign'
import { createCampaign, getAllCampaigns, deleteCampaign } from '@/services/batchCampaignService'
import { toast } from '@/state/useToastStore'
import { useSettingsStore } from '@/state/useSettingsStore'
import { timeAgo } from '@/utils/date'
import { COUNTRIES, flag } from './SearchConsole'

export default function BatchCampaignPanel() {
  const [campaigns, setCampaigns] = useState<BatchCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null)

  const { settings } = useSettingsStore()

  // Form state
  const [keyword, setKeyword] = useState('')
  const [citiesText, setCitiesText] = useState('')
  const [country, setCountry] = useState(settings.lastCountry || 'IN')
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

  function parseCities(text: string): string[] {
    return text
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean)
  }

  async function handleStart() {
    const cities = parseCities(citiesText)
    if (!keyword.trim()) { toast.error('Enter a keyword'); return }
    if (cities.length < 2) { toast.error('Enter at least 2 cities'); return }
    if (activeCampaignId !== null) { toast.error('A campaign is already running — stop it first'); return }

    setStarting(true)
    try {
      // Two-step: persist the campaign to IndexedDB first so the service worker
      // can load it by ID. The service worker only receives the ID, never the full
      // object — this avoids large payloads crossing the message boundary and ensures
      // the campaign survives a service worker restart mid-run.
      const campaignId = await createCampaign({
        keyword: keyword.trim(),
        cities: cities.map(city => ({
          city,
          status: 'pending',
          capturedCount: 0,
        })),
        country,
        autoResearch,
      })

      const res: any = await chrome.runtime.sendMessage({
        type: MSG.BATCH_CAMPAIGN_START,
        payload: { campaignId },
      })

      if (res?.ok) {
        toast.success(`Campaign started — ${cities.length} cities queued`)
        setShowForm(false)
        setKeyword('')
        setCitiesText('')
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

  const cities = parseCities(citiesText)

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Multi-City Batch Campaigns</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Search one keyword across multiple cities automatically — Maps opens, captures, closes, moves to next city
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

            <div className="col-span-2">
              <label className="text-xs text-gray-400 block mb-1.5">
                Cities <span className="text-gray-600">(one per line or comma-separated)</span>
              </label>
              <textarea
                value={citiesText}
                onChange={e => setCitiesText(e.target.value)}
                rows={5}
                placeholder={'Mumbai\nPune\nAhmedabad\nSurat\nIndore'}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                  focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none font-mono"
              />
              {cities.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {cities.map(c => (
                    <span key={c} className="text-xs px-2 py-0.5 bg-blue-950 border border-blue-800 text-blue-300 rounded-full">
                      {c}
                    </span>
                  ))}
                  <span className="text-xs text-gray-600 self-center">{cities.length} cities</span>
                </div>
              )}
            </div>

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
              <div className="text-xs text-gray-600 mt-1">Stamped on every captured lead — used for grouping, Google region &amp; AI prompts</div>
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
            {campaign.country && <span className="text-xs">{flag(campaign.country)}</span>}
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
      {city.city}
      {city.status === 'completed' && city.capturedCount > 0 && (
        <span className="text-green-600">({city.capturedCount})</span>
      )}
    </span>
  )
}
