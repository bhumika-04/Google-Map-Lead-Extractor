import React, { useState, useEffect, useRef } from 'react'
import { MSG } from '@/types/messages'
import type { SearchStartPayload } from '@/types/messages'
import { searchSessionRepository } from '@/db/searchSessionRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import { buildMapsSearchUrl, buildGeneratedQuery } from '@/services/mapsUrlService'
import { useSettingsStore } from '@/state/useSettingsStore'
import { useSearchStore } from '@/state/useSearchStore'
import { useCaptureStore } from '@/state/useCaptureStore'
import { toast } from '@/state/useToastStore'
import { nowISO } from '@/utils/date'
import SearchPresets from './SearchPresets'

// ─── Synonym / related-terms map ─────────────────────────────────────────────
// Normalised lowercase keyword → related search terms
const SYNONYM_MAP: Record<string, string[]> = {
  'printing':          ['Offset Printing', 'Digital Printing', 'Screen Printing', 'Flex Printing', 'Book Printing', 'Label Printing'],
  'print':             ['Offset Printing', 'Digital Printing', 'Screen Printing', 'Flex Printing'],
  'packaging':         ['Packaging Manufacturer', 'Carton Manufacturer', 'Box Manufacturer', 'Corrugated Box', 'Plastic Packaging'],
  'pharma':            ['Pharmaceutical Manufacturer', 'Medicine Manufacturer', 'Drug Company', 'API Manufacturer'],
  'pharmaceutical':    ['Pharma Manufacturer', 'Medicine Manufacturer', 'Drug Company', 'API Manufacturer'],
  'textile':           ['Fabric Manufacturer', 'Garment Manufacturer', 'Clothing Manufacturer', 'Yarn Manufacturer'],
  'garment':           ['Clothing Manufacturer', 'Textile Manufacturer', 'Apparel Manufacturer', 'Fabric Supplier'],
  'ca':                ['Chartered Accountant', 'Tax Consultant', 'GST Consultant', 'Audit Firm', 'Accounting Firm'],
  'chartered':         ['CA Firm', 'Tax Consultant', 'GST Consultant', 'Audit Firm'],
  'it company':        ['Software Company', 'Web Development', 'App Development', 'IT Services'],
  'software':          ['IT Company', 'Web Development', 'App Development', 'Digital Agency'],
  'hospital':          ['Clinic', 'Nursing Home', 'Diagnostic Centre', 'Pathology Lab', 'Medical Centre'],
  'clinic':            ['Hospital', 'Nursing Home', 'Diagnostic Centre', 'Medical Centre'],
  'dentist':           ['Dental Clinic', 'Dental Hospital', 'Orthodontist', 'Dental Care'],
  'dental':            ['Dentist', 'Dental Hospital', 'Orthodontist'],
  'restaurant':        ['Hotel', 'Dhaba', 'Food Court', 'Tiffin Service', 'Cafe', 'Bakery'],
  'hotel':             ['Restaurant', 'Dhaba', 'Resort', 'Lodge', 'Guest House'],
  'real estate':       ['Property Dealer', 'Builder', 'Developer', 'Construction Company', 'Land Dealer'],
  'builder':           ['Real Estate Developer', 'Construction Company', 'Contractor', 'Property Developer'],
  'lawyer':            ['Advocate', 'Law Firm', 'Legal Services', 'Legal Consultant'],
  'advocate':          ['Lawyer', 'Law Firm', 'Legal Services'],
  'transport':         ['Logistics', 'Courier Service', 'Cargo', 'Freight', 'Packers and Movers'],
  'logistics':         ['Transport', 'Courier Service', 'Cargo', 'Freight', 'Supply Chain'],
  'steel':             ['Iron Manufacturer', 'Metal Fabrication', 'Steel Supplier', 'Metal Works'],
  'plastic':           ['Plastic Manufacturer', 'Injection Moulding', 'Polymer Products', 'PVC Products'],
  'electrical':        ['Electrician', 'Electrical Contractor', 'Panel Manufacturer', 'Wiring'],
  'furniture':         ['Interior Designer', 'Wood Work', 'Modular Furniture', 'Office Furniture'],
  'construction':      ['Builder', 'Contractor', 'Civil Contractor', 'Infrastructure'],
  'school':            ['Coaching Centre', 'Tuition', 'Academy', 'Institute', 'College'],
  'education':         ['School', 'College', 'Coaching Centre', 'Academy', 'Institute'],
  'food':              ['Food Processing', 'Food Manufacturer', 'Bakery', 'Catering'],
  'chemical':          ['Chemical Manufacturer', 'Specialty Chemical', 'Agrochemical', 'Industrial Chemical'],
  'engineering':       ['Fabrication', 'Machine Parts', 'CNC Machining', 'Tooling', 'Sheet Metal'],
}

function getSuggestions(keyword: string): string[] {
  if (!keyword.trim()) return []
  const lower = keyword.toLowerCase().trim()
  // Exact match first, then partial match
  for (const [key, terms] of Object.entries(SYNONYM_MAP)) {
    if (lower === key || lower.includes(key) || key.includes(lower)) {
      return terms
    }
  }
  return []
}

const UNLIMITED = 9999

export default function SearchConsole() {
  const { settings, update: updateSettings } = useSettingsStore()
  const { addSession } = useSearchStore()
  const { status, totalCaptured, setStatus, setSession, reset, appendLog } = useCaptureStore()

  const [city, setCity]       = useState(settings.lastCity ?? '')
  const [keyword, setKeyword] = useState(settings.lastKeyword ?? '')

  // Related search terms (synonyms)
  const [suggestions, setSuggestions]     = useState<string[]>([])
  const [selectedTerms, setSelectedTerms] = useState<string[]>([])

  // Multi-term queue tracking
  const termsQueueRef  = useRef<string[]>([])
  const termIndexRef   = useRef(0)
  const totalLeadsRef  = useRef(0)

  const [currentTermLabel, setCurrentTermLabel] = useState('')
  const [termProgress, setTermProgress]         = useState({ current: 0, total: 0 })

  const [error, setError] = useState('')

  const isRunning = status === 'running' || status === 'opening_maps'

  // Pre-fill once settings finish loading
  useEffect(() => {
    if (settings.lastCity    && !city)    setCity(settings.lastCity)
    if (settings.lastKeyword && !keyword) setKeyword(settings.lastKeyword)
  }, [settings.lastCity, settings.lastKeyword])

  // Update synonym suggestions when keyword changes
  useEffect(() => {
    const newSuggestions = getSuggestions(keyword)
    setSuggestions(newSuggestions)
    // Clear selected terms that are no longer in suggestions
    setSelectedTerms((prev) => prev.filter((t) => newSuggestions.includes(t)))
  }, [keyword])

  // Auto-advance to next term when current session completes
  useEffect(() => {
    if (status === 'completed') {
      totalLeadsRef.current += totalCaptured
      const queue = termsQueueRef.current
      const nextIndex = termIndexRef.current + 1
      if (nextIndex < queue.length) {
        termIndexRef.current = nextIndex
        const nextKeyword = queue[nextIndex]
        setTermProgress({ current: nextIndex + 1, total: queue.length })
        // Small delay before starting next search
        setTimeout(() => startMapSearch(nextKeyword, nextIndex, queue.length), 1500)
      } else {
        // All terms done
        termsQueueRef.current = []
        termIndexRef.current  = 0
        if (queue.length > 1) {
          toast.success(`All ${queue.length} searches complete — ${totalLeadsRef.current} total leads captured`)
          totalLeadsRef.current = 0
        }
        setTermProgress({ current: 0, total: 0 })
        setCurrentTermLabel('')
      }
    }
  }, [status])

  function toggleTerm(term: string) {
    setSelectedTerms((prev) =>
      prev.includes(term) ? prev.filter((t) => t !== term) : [...prev, term]
    )
  }

  async function startMapSearch(kw: string, index: number, total: number) {
    const generatedQuery = buildGeneratedQuery(kw, city.trim())
    const mapsUrl        = buildMapsSearchUrl(kw, city.trim())

    const sessionId = await searchSessionRepository.create({
      city:             city.trim(),
      keyword:          kw,
      generatedQuery,
      mapsUrl,
      status:           'idle',
      maxResults:       UNLIMITED,
      totalCaptured:    0,
      duplicatesSkipped: 0,
    })

    const session = await searchSessionRepository.getById(sessionId)
    if (session) addSession(session)

    reset()
    setSession(sessionId)
    setStatus('opening_maps')
    setCurrentTermLabel(total > 1 ? `${kw} (${index + 1}/${total})` : kw)

    appendLog(`Search started: ${generatedQuery}`)
    await activityLogRepository.log('search_started', `Search: ${generatedQuery}`, sessionId)
    if (index === 0) toast.info(`Opening Google Maps for "${generatedQuery}"`)
    else             toast.info(`Next search: "${generatedQuery}"`)

    const payload: SearchStartPayload = {
      sessionId,
      city:     city.trim(),
      keyword:  kw,
      maxResults: UNLIMITED,
      mapsUrl,
      settings: {
        autoScrollDelay:         settings.autoScrollDelay,
        maxScrollAttempts:       settings.maxScrollAttempts,
        noNewLeadStopThreshold:  settings.noNewLeadStopThreshold,
      },
    }

    chrome.runtime.sendMessage({ type: MSG.SEARCH_START, payload }).catch(() => {
      setError('Failed to communicate with background worker. Try reloading the extension.')
      setStatus('error')
      toast.error('Could not start capture — try reloading the extension.')
    })
  }

  async function handleStart() {
    setError('')
    if (!city.trim())    { setError('Please enter a city.'); return }
    if (!keyword.trim()) { setError('Please enter a keyword or business category.'); return }
    await updateSettings({ lastCity: city.trim(), lastKeyword: keyword.trim() })

    const queue = [keyword.trim(), ...selectedTerms]
    termsQueueRef.current = queue
    termIndexRef.current  = 0
    totalLeadsRef.current = 0
    setTermProgress({ current: 1, total: queue.length })

    await startMapSearch(queue[0], 0, queue.length)
  }

  async function handleStop() {
    termsQueueRef.current = [] // cancel remaining queue
    termIndexRef.current  = 0
    await chrome.runtime.sendMessage({ type: MSG.CAPTURE_STOP })
    setStatus('stopped')
    setTermProgress({ current: 0, total: 0 })
    setCurrentTermLabel('')
    appendLog('Capture stopped by user')
    toast.warning('Capture stopped')
  }

  const allTerms         = [keyword.trim(), ...selectedTerms].filter(Boolean)
  const hasMultipleTerms = allTerms.length > 1

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white text-sm">Search Console</h2>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-green-400 font-medium">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            {currentTermLabel ? `Searching: ${currentTermLabel}` : 'Capture Active'}
          </span>
        )}
      </div>

      {/* Input grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1 font-medium">City</label>
          <input
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isRunning && handleStart()}
            placeholder="e.g. Indore, Mumbai, Delhi"
            disabled={isRunning}
            className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg placeholder-gray-600
              focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50 transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1 font-medium">Keyword / Business Category</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isRunning && handleStart()}
            placeholder="e.g. Printing, CA Firms, Dentists"
            disabled={isRunning}
            className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg placeholder-gray-600
              focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50 transition-colors"
          />
        </div>
      </div>

      {/* Related search terms */}
      {!isRunning && suggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">Also search for</span>
            {selectedTerms.length > 0 && (
              <span className="text-xs text-blue-400">
                +{selectedTerms.length} term{selectedTerms.length > 1 ? 's' : ''} selected
              </span>
            )}
            {selectedTerms.length > 0 && (
              <button
                onClick={() => setSelectedTerms([])}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((term) => {
              const active = selectedTerms.includes(term)
              return (
                <button
                  key={term}
                  onClick={() => toggleTerm(term)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? 'bg-blue-700 border-blue-600 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-blue-700 hover:text-blue-300'
                  }`}
                >
                  {active ? '✓ ' : '+ '}{term}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Search queue preview */}
      {!isRunning && hasMultipleTerms && (
        <div className="bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2 space-y-1">
          <div className="text-xs text-blue-300 font-medium">Will search {allTerms.length} terms sequentially:</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {allTerms.map((t, i) => (
              <span key={t} className="text-xs px-2 py-0.5 bg-blue-900/40 text-blue-200 rounded border border-blue-800/40">
                {i + 1}. {t}
              </span>
            ))}
          </div>
          <div className="text-xs text-blue-400/70">Duplicates across searches are automatically skipped</div>
        </div>
      )}

      {/* Search presets */}
      <SearchPresets
        city={city}
        keyword={keyword}
        maxResults={100}
        onLoad={(c, k) => { setCity(c); setKeyword(k) }}
      />

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 bg-red-950 border border-red-800 text-red-300 text-xs px-3 py-2 rounded-lg">
          <span className="shrink-0 mt-0.5">✕</span>
          <span>{error}</span>
        </div>
      )}

      {/* Progress — multi-term */}
      {isRunning && termProgress.total > 1 && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Term {termProgress.current} of {termProgress.total}</span>
            <span className="font-medium text-white">{totalCaptured} leads this search</span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.round(((termProgress.current - 1) / termProgress.total) * 100)}%` }}
            />
          </div>
          <div className="text-xs text-gray-600">
            {totalLeadsRef.current > 0 && `${totalLeadsRef.current} leads collected so far`}
          </div>
        </div>
      )}

      {/* Progress — single term */}
      {isRunning && termProgress.total <= 1 && totalCaptured > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <span>{totalCaptured} leads captured — scrolling for more…</span>
        </div>
      )}

      {/* Completed */}
      {(status === 'completed' || status === 'stopped') && termProgress.total === 0 && (
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>{status === 'completed' ? 'Search complete' : 'Search stopped'}</span>
          <span className="font-medium text-white">{totalCaptured} leads captured</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 flex-wrap items-center">
        {!isRunning ? (
          <button
            onClick={handleStart}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold
              rounded-lg transition-colors shadow-sm shadow-blue-900/40"
          >
            {hasMultipleTerms ? `Start Search (${allTerms.length} terms)` : 'Start Search'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Stop Capture
          </button>
        )}

        {!isRunning && (city || keyword) && (
          <button
            onClick={() => { setCity(''); setKeyword(''); setSelectedTerms([]); setError('') }}
            className="px-3 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
