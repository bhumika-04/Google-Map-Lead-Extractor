import React, { useMemo } from 'react'
import { useLeadStore } from '@/state/useLeadStore'
import { useSearchStore } from '@/state/useSearchStore'
import { calculateLeadScore, scoreLabel, scoreColor } from '@/utils/leadScore'

export default function AnalyticsSection() {
  const { leads } = useLeadStore()
  const { sessions } = useSearchStore()

  const stats = useMemo(() => {
    if (leads.length === 0) return null
    const scores = leads.map(calculateLeadScore)
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    const withPhone   = leads.filter((l) => !!l.phone).length
    const withWebsite = leads.filter((l) => !!l.website).length

    const hot  = scores.filter((s) => s >= 80).length
    const good = scores.filter((s) => s >= 55 && s < 80).length
    const fair = scores.filter((s) => s >= 30 && s < 55).length
    const weak = scores.filter((s) => s < 30).length

    // Top categories
    const catMap: Record<string, number> = {}
    for (const l of leads) {
      const c = l.category?.trim() || 'Unknown'
      catMap[c] = (catMap[c] ?? 0) + 1
    }
    const topCats = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)

    return { avgScore, withPhone, withWebsite, hot, good, fair, weak, topCats }
  }, [leads])

  const maxSessionLeads = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, s.totalCaptured), 1),
    [sessions]
  )

  if (leads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-72 text-gray-700">
        <div className="text-5xl mb-3 opacity-20">▦</div>
        <div className="text-sm text-gray-500">No leads yet — run a search to see analytics</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Leads"    value={leads.length}                              sub="in database" />
        <StatCard label="Avg Score"      value={stats!.avgScore}                            sub={scoreLabel(stats!.avgScore)} color={scoreColor(stats!.avgScore)} />
        <StatCard label="Phone Coverage" value={`${Math.round(stats!.withPhone  / leads.length * 100)}%`} sub={`${stats!.withPhone} leads`} />
        <StatCard label="Has Website"    value={`${Math.round(stats!.withWebsite / leads.length * 100)}%`} sub={`${stats!.withWebsite} leads`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

        {/* Score distribution */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-4">Lead Quality Distribution</h3>
          <div className="space-y-2.5">
            {[
              { label: 'Hot',  count: stats!.hot,  bar: 'bg-green-500',  text: 'text-green-400' },
              { label: 'Good', count: stats!.good, bar: 'bg-blue-500',   text: 'text-blue-400' },
              { label: 'Fair', count: stats!.fair, bar: 'bg-yellow-500', text: 'text-yellow-400' },
              { label: 'Weak', count: stats!.weak, bar: 'bg-gray-600',   text: 'text-gray-400' },
            ].map(({ label, count, bar, text }) => (
              <div key={label} className="flex items-center gap-3">
                <div className={`text-xs font-semibold w-8 text-right ${text}`}>{count}</div>
                <div className="text-xs text-gray-500 w-8">{label}</div>
                <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${bar} rounded-full transition-all`}
                    style={{ width: leads.length ? `${count / leads.length * 100}%` : '0%' }}
                  />
                </div>
                <div className="text-xs text-gray-600 w-8 text-right">
                  {leads.length ? `${Math.round(count / leads.length * 100)}%` : '—'}
                </div>
              </div>
            ))}
          </div>

          {/* Stacked bar summary */}
          <div className="mt-4 h-2.5 bg-gray-800 rounded-full overflow-hidden flex">
            {stats!.hot  > 0 && <div className="bg-green-500  h-full" style={{ width: `${stats!.hot  / leads.length * 100}%` }} />}
            {stats!.good > 0 && <div className="bg-blue-500   h-full" style={{ width: `${stats!.good / leads.length * 100}%` }} />}
            {stats!.fair > 0 && <div className="bg-yellow-500 h-full" style={{ width: `${stats!.fair / leads.length * 100}%` }} />}
            {stats!.weak > 0 && <div className="bg-gray-600   h-full" style={{ width: `${stats!.weak / leads.length * 100}%` }} />}
          </div>
        </div>

        {/* Top categories */}
        {stats!.topCats.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-4">Top Categories</h3>
            <div className="space-y-2">
              {stats!.topCats.map(([cat, count]) => (
                <div key={cat} className="flex items-center gap-3">
                  <div className="text-xs text-gray-400 truncate w-28 shrink-0">{cat}</div>
                  <div className="flex-1 h-2.5 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600/70 rounded-full"
                      style={{ width: `${count / stats!.topCats[0][1] * 100}%` }}
                    />
                  </div>
                  <div className="text-xs text-gray-400 font-semibold w-6 text-right">{count}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sessions chart */}
      {sessions.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-4">
            Session Performance
            <span className="ml-2 text-xs text-gray-600 font-normal">last {Math.min(sessions.length, 10)}</span>
          </h3>
          <div className="space-y-2">
            {sessions.slice(0, 10).map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <div className="text-xs text-gray-500 shrink-0 w-24 truncate">{s.keyword}</div>
                <div className="text-xs text-gray-700 shrink-0 w-16 truncate">{s.city}</div>
                <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      s.status === 'completed' ? 'bg-green-600/70' :
                      s.status === 'running'   ? 'bg-blue-500 animate-pulse' :
                                                 'bg-yellow-600/50'
                    }`}
                    style={{ width: `${Math.round(s.totalCaptured / maxSessionLeads * 100)}%` }}
                  />
                </div>
                <div className="text-xs font-semibold text-green-400 w-8 text-right shrink-0">{s.totalCaptured}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status breakdown */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-white mb-4">Lead Status Breakdown</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'New',      color: 'text-blue-400',   count: leads.filter((l) => l.status === 'new').length },
            { label: 'Selected', color: 'text-green-400',  count: leads.filter((l) => l.status === 'selected').length },
            { label: 'Rejected', color: 'text-red-400',    count: leads.filter((l) => l.status === 'rejected').length },
            { label: 'Research', color: 'text-purple-400', count: leads.filter((l) => l.status.startsWith('research')).length },
          ].map(({ label, color, count }) => (
            <div key={label} className="bg-gray-800 rounded-lg p-3 text-center">
              <div className={`text-2xl font-bold ${color}`}>{count}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              <div className="text-xs text-gray-700 mt-0.5">
                {leads.length ? `${Math.round(count / leads.length * 100)}%` : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatCard({
  label, value, sub, color,
}: {
  label: string; value: string | number; sub?: string; color?: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold text-white ${color ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
    </div>
  )
}
