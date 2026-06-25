import React, { useEffect } from 'react'
import { useSettingsStore } from '@/state/useSettingsStore'
import { db } from '@/db/db'
import { useCaptureStore } from '@/state/useCaptureStore'

export default function SettingsPanel() {
  const { settings, loaded, load, update, reset } = useSettingsStore()
  const { reset: resetCapture } = useCaptureStore()

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

  async function handleClearAll() {
    if (!confirm('This will permanently delete all leads, sessions, research jobs, and activity logs. Are you sure?')) return
    await db.searchSessions.clear()
    await db.leads.clear()
    await db.researchJobs.clear()
    await db.activityLogs.clear()
    resetCapture()
    alert('All local data cleared.')
  }

  if (!loaded) {
    return <div className="text-gray-500 text-sm p-4">Loading settings...</div>
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-5 items-start">
        {/* Capture Settings */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-white text-sm">Capture Settings</h3>

          <SettingRow
            label="Auto-scroll Delay"
            description="ms between each scroll step"
            value={settings.autoScrollDelay}
            min={500}
            max={10000}
            step={100}
            unit="ms"
            onChange={(v) => update({ autoScrollDelay: v })}
          />

          <SettingRow
            label="Max Scroll Attempts"
            description="Max scroll iterations before stopping"
            value={settings.maxScrollAttempts}
            min={10}
            max={200}
            onChange={(v) => update({ maxScrollAttempts: v })}
          />

          <SettingRow
            label="No-new-lead Threshold"
            description="Stop after this many empty scrolls"
            value={settings.noNewLeadStopThreshold}
            min={2}
            max={20}
            onChange={(v) => update({ noNewLeadStopThreshold: v })}
          />

          <SettingRow
            label="Default Max Results"
            description="Default lead limit per session"
            value={settings.defaultMaxResults}
            min={10}
            max={500}
            onChange={(v) => update({ defaultMaxResults: v })}
          />
        </div>

        {/* Data Capture */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-white text-sm">Data Capture</h3>

          <ToggleRow
            label="Capture Phone"
            description="Extract phone numbers from business cards"
            value={settings.capturePhone}
            onChange={(v) => update({ capturePhone: v })}
          />

          <ToggleRow
            label="Capture Website"
            description="Extract website URLs from business cards"
            value={settings.captureWebsite}
            onChange={(v) => update({ captureWebsite: v })}
          />

          <ToggleRow
            label="Enable Debug Logs"
            description="Show detailed debug output in browser console"
            value={settings.enableDebugLogs}
            onChange={(v) => update({ enableDebugLogs: v })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5">
      {/* Lead Validation — Business Profile */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4 flex flex-col">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-white text-sm">My Business Profile</h3>
          <span className="text-xs px-2 py-0.5 bg-blue-900 text-blue-300 rounded-full border border-blue-800">AI Validation</span>
        </div>
        <p className="text-xs text-gray-500">
          Describe your business and what you offer. This is used to automatically validate leads from your Lead Database —
          filtering out irrelevant ones (gift shops, stationary stores, etc.) and selecting only suitable prospects.
        </p>
        <div className="space-y-1.5 flex-1 flex flex-col">
          <label className="text-xs text-gray-400 font-medium">What does your business do?</label>
          <textarea
            value={settings.businessProfile}
            onChange={(e) => update({ businessProfile: e.target.value })}
            placeholder="e.g. We are a software company providing ERP solutions for printing and packaging manufacturers. We help mid-sized factories automate production planning, inventory, dispatch, and billing. Our target customers are printing companies, packaging manufacturers, and pharmaceutical packaging units with 50+ employees."
            className="flex-1 min-h-32 w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
              placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
              transition-colors resize-none leading-relaxed"
          />
          {settings.businessProfile && (
            <div className="flex items-center gap-1.5 text-xs text-green-400">
              <span>✓</span> Profile saved — {settings.businessProfile.split(' ').length} words
            </div>
          )}
        </div>
        <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs text-gray-600 space-y-0.5">
          <div>• Be specific about your product, industry focus, and ideal customer size</div>
          <div>• Mention company types you can NOT serve (e.g. "not for retail shops")</div>
          <div>• Requires Gemini API key to run validation</div>
        </div>
      </div>

      {/* Phase 2 — AI Research */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-white text-sm">AI Research — Phase 2</h3>
          <span className="text-xs px-2 py-0.5 bg-purple-900 text-purple-300 rounded-full border border-purple-800">New</span>
        </div>
        <p className="text-xs text-gray-500">
          Choose your AI provider and enter the API key to enable automatic lead enrichment with decision makers,
          emails, business summaries, and more.
        </p>

        {/* Provider selector */}
        <div className="space-y-1.5">
          <label className="text-xs text-gray-400 font-medium">AI Provider</label>
          <div className="flex gap-2">
            {([
              { id: 'gemini',    label: 'Gemini',    badge: 'Recommended' },
              { id: 'openai',    label: 'OpenAI',    badge: null },
              { id: 'anthropic', label: 'Anthropic', badge: null },
            ] as const).map((p) => (
              <button
                key={p.id}
                onClick={() => update({ researchProvider: p.id })}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border relative ${
                  settings.researchProvider === p.id
                    ? 'bg-purple-700 text-white border-purple-600'
                    : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500'
                }`}
              >
                {p.label}
                {p.badge && (
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[9px] px-1.5 py-0.5 bg-green-700 text-green-100 rounded-full whitespace-nowrap">
                    {p.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Gemini settings */}
        {settings.researchProvider === 'gemini' && (
          <>
            <div className="bg-blue-950/40 border border-blue-900/50 rounded-lg px-3 py-2 text-xs text-blue-300 space-y-0.5">
              <div className="font-medium text-blue-200">Why Gemini?</div>
              <div>• Searches Google live — finds MCA filings, LinkedIn, website simultaneously</div>
              <div>• Extracts turnover, directors, clients, certifications from real-time sources</div>
              <div>• Far better data quality than static AI models</div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium">Google AI (Gemini) API Key</label>
              <input
                type="password"
                value={settings.geminiApiKey}
                onChange={(e) => update({ geminiApiKey: e.target.value.trim() })}
                placeholder="AIza..."
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                  placeholder-gray-600 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors"
              />
              {settings.geminiApiKey
                ? <div className="flex items-center gap-1.5 text-xs text-green-400"><span>✓</span> API key saved</div>
                : <div className="text-xs text-gray-600">Get free key at aistudio.google.com</div>
              }
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium">Model</label>
              <select
                value={settings.geminiModel}
                onChange={(e) => update({ geminiModel: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500"
              >
                <option value="gemini-2.5-flash">Gemini 2.5 Flash — Best quality + Search Grounding (recommended)</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash — Fast + Search Grounding</option>
                <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite — Budget option</option>
                <option value="gemini-1.5-flash">Gemini 1.5 Flash — Separate quota pool (1500 RPD free)</option>
                <option value="gemini-1.5-flash-8b">Gemini 1.5 Flash 8B — Lightest, highest free quota</option>
              </select>
            </div>
          </>
        )}

        {/* OpenAI settings */}
        {settings.researchProvider === 'openai' && (
          <>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium">OpenAI API Key</label>
              <input
                type="password"
                value={settings.openAiApiKey}
                onChange={(e) => update({ openAiApiKey: e.target.value.trim() })}
                placeholder="sk-proj-..."
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                  placeholder-gray-600 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors"
              />
              {settings.openAiApiKey && (
                <div className="flex items-center gap-1.5 text-xs text-green-400"><span>✓</span> API key saved</div>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium">Model</label>
              <select
                value={settings.openAiModel}
                onChange={(e) => update({ openAiModel: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500"
              >
                <option value="gpt-4o-mini">GPT-4o Mini — Fast &amp; affordable (recommended)</option>
                <option value="gpt-4o">GPT-4o — Best quality</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
              </select>
            </div>
          </>
        )}

        {/* Anthropic settings */}
        {settings.researchProvider === 'anthropic' && (
          <>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium">Anthropic API Key</label>
              <input
                type="password"
                value={settings.anthropicApiKey}
                onChange={(e) => update({ anthropicApiKey: e.target.value.trim() })}
                placeholder="sk-ant-api03-..."
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                  placeholder-gray-600 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors"
              />
              {settings.anthropicApiKey && (
                <div className="flex items-center gap-1.5 text-xs text-green-400"><span>✓</span> API key saved</div>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium">Model</label>
              <select
                value={settings.anthropicModel}
                onChange={(e) => update({ anthropicModel: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500"
              >
                <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 — Fast &amp; affordable</option>
                <option value="claude-sonnet-4-6">Claude Sonnet 4.6 — Balanced</option>
              </select>
            </div>
          </>
        )}

        <ToggleRow
          label="Auto-Research New Leads"
          description="Automatically queue all new leads for research after capture"
          value={settings.autoResearch}
          onChange={(v) => update({ autoResearch: v })}
        />

        <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs text-gray-600 space-y-0.5">
          <div>• Research runs automatically every minute via background alarm</div>
          <div>• One job processed at a time to avoid rate limits</div>
          <div>• API keys are stored locally in IndexedDB — never sent to our servers</div>
        </div>
      </div>
      </div>{/* end 2-col grid */}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <h3 className="font-semibold text-white text-sm">Data Management</h3>
        <div className="flex gap-3">
          <button
            onClick={reset}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
          >
            Reset to Defaults
          </button>
          <button
            onClick={handleClearAll}
            className="px-4 py-2 bg-red-900 hover:bg-red-800 text-red-200 text-sm rounded-lg transition-colors"
          >
            Clear All Local Data
          </button>
        </div>
        <p className="text-xs text-gray-600">
          Data is stored locally in IndexedDB. Nothing is sent to any server.
        </p>
      </div>
    </div>
  )
}

// ─── Helper components ────────────────────────────────────────────────────────

interface SettingRowProps {
  label: string
  description: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}

function SettingRow({ label, description, value, min, max, step = 1, unit, onChange }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-white font-medium leading-tight">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{description}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded-lg text-right focus:outline-none focus:border-blue-500"
        />
        {unit && <span className="text-xs text-gray-500">{unit}</span>}
      </div>
    </div>
  )
}

interface ToggleRowProps {
  label: string
  description: string
  value: boolean
  onChange: (v: boolean) => void
}

function ToggleRow({ label, description, value, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 pr-1">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white font-medium leading-tight">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{description}</div>
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative shrink-0 w-10 h-5 rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-gray-600'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}
