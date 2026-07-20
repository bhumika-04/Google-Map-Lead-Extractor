import React, { useEffect, useMemo, useState } from 'react'
import { leadRepository } from '@/db/leadRepository'
import { useLeadStore } from '@/state/useLeadStore'
import { toast } from '@/state/useToastStore'
import { COUNTRIES, COUNTRY_CITIES, flag } from './SearchConsole'
import type { Lead } from '@/types/lead'
import type { NavSection } from './Sidebar'

const COUNTRY_NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  COUNTRIES.map((c) => [c.code, c.name])
)

// Reverse lookup: lowercase city name → ISO country code, built once from
// SearchConsole's COUNTRY_CITIES map. Used to backfill leads whose `country`
// field is missing (captured before the field existed, or via a batch
// campaign that predates country stamping).
const CITY_TO_COUNTRY: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const [code, cities] of Object.entries(COUNTRY_CITIES)) {
    for (const city of cities) map[city.toLowerCase()] = code
  }
  return map
})()

function inferCountry(city: string): string | null {
  return CITY_TO_COUNTRY[city.trim().toLowerCase()] ?? null
}

interface CountryGroup {
  code: string
  name: string
  leads: Lead[]
  cities: Map<string, Lead[]>
}

function groupLeads(leads: Lead[]): CountryGroup[] {
  const byCountry = new Map<string, Lead[]>()
  for (const lead of leads) {
    const code = (lead.country || '??').toUpperCase()
    if (!byCountry.has(code)) byCountry.set(code, [])
    byCountry.get(code)!.push(lead)
  }

  const groups: CountryGroup[] = []
  for (const [code, countryLeads] of byCountry) {
    const cities = new Map<string, Lead[]>()
    for (const lead of countryLeads) {
      const city = (lead.city || 'Unknown').trim()
      if (!cities.has(city)) cities.set(city, [])
      cities.get(city)!.push(lead)
    }
    groups.push({
      code,
      name: code === '??' ? 'Unassigned' : (COUNTRY_NAME_BY_CODE[code] ?? code),
      leads: countryLeads,
      cities,
    })
  }

  // Unassigned always last; others by lead count desc
  return groups.sort((a, b) => {
    if (a.code === '??') return 1
    if (b.code === '??') return -1
    return b.leads.length - a.leads.length
  })
}

function countStats(leads: Lead[]) {
  const validated = leads.filter((l) => l.validationStatus === 'relevant' || l.status === 'selected' || l.status === 'research_pending' || l.status === 'research_running' || l.status === 'research_completed' || l.status === 'research_failed').length
  const researched = leads.filter((l) => l.status === 'research_completed').length
  return { validated, researched }
}

interface MarketsPageProps {
  onNavigate: (section: NavSection) => void
}

export default function MarketsPage({ onNavigate }: MarketsPageProps) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [drilldownCountry, setDrilldownCountry] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const { setMarketScope } = useLeadStore()

  async function load() {
    setLoading(true)
    const all = await leadRepository.getAll()
    setLeads(all)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const groups = useMemo(() => groupLeads(leads), [leads])
  const unassignedCount = groups.find((g) => g.code === '??')?.leads.length ?? 0
  const backfillableCount = useMemo(() => {
    const unassigned = groups.find((g) => g.code === '??')
    if (!unassigned) return 0
    return unassigned.leads.filter((l) => inferCountry(l.city)).length
  }, [groups])

  async function handleBackfill() {
    setBackfilling(true)
    try {
      const unassigned = groups.find((g) => g.code === '??')
      if (!unassigned) { toast.info('Nothing to backfill'); return }

      const byCountry = new Map<string, number[]>()
      for (const lead of unassigned.leads) {
        const inferred = inferCountry(lead.city)
        if (!inferred || !lead.id) continue
        if (!byCountry.has(inferred)) byCountry.set(inferred, [])
        byCountry.get(inferred)!.push(lead.id)
      }

      let updated = 0
      for (const [code, ids] of byCountry) {
        await leadRepository.updateMany(ids, { country: code })
        updated += ids.length
      }

      toast.success(`Backfilled country for ${updated} leads from city name`)
      await load()
    } catch {
      toast.error('Backfill failed — check console')
    } finally {
      setBackfilling(false)
    }
  }

  function openCity(countryCode: string, countryName: string, city?: string) {
    setMarketScope({ country: countryCode, countryName, city })
    onNavigate('leads')
  }

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-28 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  if (leads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-700 bg-gray-900 border border-gray-800 rounded-xl">
        <div className="text-4xl mb-2 opacity-30">🌍</div>
        <div className="text-sm text-gray-500">No leads captured yet</div>
      </div>
    )
  }

  const drilldown = groups.find((g) => g.code === drilldownCountry)

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Markets</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {drilldown
              ? <>{flag(drilldown.code)} {drilldown.name} — click a city to view its leads</>
              : 'Leads grouped by country and city — click a card to drill in'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {drilldown && (
            <button
              onClick={() => setDrilldownCountry(null)}
              className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
            >
              ← All Countries
            </button>
          )}
          {!drilldown && unassignedCount > 0 && backfillableCount > 0 && (
            <button
              onClick={handleBackfill}
              disabled={backfilling}
              className="text-xs px-3 py-1.5 bg-purple-900 hover:bg-purple-800 disabled:opacity-50 text-purple-200 rounded-lg transition-colors"
              title="Infer country from city name for unassigned leads"
            >
              {backfilling ? 'Backfilling…' : `🔧 Backfill ${backfillableCount} leads`}
            </button>
          )}
        </div>
      </div>

      {/* Country cards */}
      {!drilldown && (
        <div className="grid grid-cols-3 gap-3">
          {groups.map((g) => {
            const { validated, researched } = countStats(g.leads)
            return (
              <button
                key={g.code}
                onClick={() => setDrilldownCountry(g.code)}
                className={`text-left p-4 rounded-xl border transition-colors ${
                  g.code === '??'
                    ? 'bg-gray-900/60 border-gray-800 border-dashed hover:border-gray-700'
                    : 'bg-gray-900 border-gray-800 hover:border-blue-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{g.code === '??' ? '❓' : flag(g.code)}</span>
                  <span className="text-sm font-semibold text-white truncate">{g.name}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {g.leads.length} leads · {g.cities.size} {g.cities.size === 1 ? 'city' : 'cities'}
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs">
                  <span className="text-green-400">✓ {validated} validated</span>
                  <span className="text-blue-400">🔬 {researched} researched</span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* City cards for the drilled-down country */}
      {drilldown && (
        <div className="space-y-3">
          <button
            onClick={() => openCity(drilldown.code, drilldown.name)}
            className="w-full text-left p-3 rounded-xl border border-blue-800 bg-blue-950/30 hover:bg-blue-950/50 transition-colors text-sm text-blue-300"
          >
            View all {drilldown.leads.length} leads in {drilldown.name} →
          </button>

          <div className="grid grid-cols-3 gap-3">
            {[...drilldown.cities.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .map(([city, cityLeads]) => {
                const { validated, researched } = countStats(cityLeads)
                const keywords = [...new Set(cityLeads.map((l) => l.keyword).filter(Boolean))]
                return (
                  <button
                    key={city}
                    onClick={() => openCity(drilldown.code, drilldown.name, city)}
                    className="text-left p-4 rounded-xl border border-gray-800 bg-gray-900 hover:border-blue-700 transition-colors"
                  >
                    <div className="text-sm font-semibold text-white truncate">{city}</div>
                    <div className="text-xs text-gray-500 mt-1">{cityLeads.length} leads</div>
                    {keywords.length > 0 && (
                      <div className="text-xs text-gray-600 mt-1 truncate">{keywords.slice(0, 2).join(', ')}{keywords.length > 2 ? '…' : ''}</div>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs">
                      <span className="text-green-400">✓ {validated}</span>
                      <span className="text-blue-400">🔬 {researched}</span>
                    </div>
                  </button>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}
