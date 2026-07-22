import React from 'react'
import { useCaptureStore } from '@/state/useCaptureStore'
import { useSearchStore } from '@/state/useSearchStore'

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  accent?: string
  icon?: string
  tint?: string   // subtle gradient tint, e.g. 'from-blue-500/10'
}

function StatCard({ label, value, sub, accent = 'text-white', icon, tint = 'from-gray-500/5' }: StatCardProps) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-1
      transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-700 hover:shadow-lg hover:shadow-black/20`}>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${tint} to-transparent`} />
      <div className="relative flex items-center justify-between">
        <span className="text-[11px] text-gray-500 font-medium uppercase tracking-wide">{label}</span>
        {icon && <span className="text-sm opacity-60">{icon}</span>}
      </div>
      <span className={`relative text-2xl font-bold ${accent}`}>{value}</span>
      {sub && <span className="relative text-xs text-gray-600">{sub}</span>}
    </div>
  )
}

export default function ProgressCards() {
  const { status, totalCaptured, duplicatesSkipped, sessionId, lastMessage } = useCaptureStore()
  const { sessions } = useSearchStore()

  const activeSession = sessions.find((s) => s.id === sessionId)
  const totalSessions = sessions.length
  const completedSessions = sessions.filter((s) => s.status === 'completed').length

  const isRunning = status === 'running' || status === 'opening_maps'

  return (
    <div className="space-y-4">
      {/* Live capture status banner */}
      {sessionId && (
        <div className={`rounded-xl border p-4 flex items-center gap-3 ${
          isRunning
            ? 'bg-green-950 border-green-800'
            : status === 'completed'
            ? 'bg-blue-950 border-blue-800'
            : status === 'stopped'
            ? 'bg-red-950 border-red-800'
            : 'bg-gray-900 border-gray-800'
        }`}>
          {isRunning && (
            <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white">
              {status === 'running' ? 'Capture in Progress' :
               status === 'opening_maps' ? 'Opening Google Maps...' :
               status === 'completed' ? 'Capture Completed' :
               status === 'stopped' ? 'Capture Stopped' : 'Capture Status'}
            </div>
            {activeSession && (
              <div className="text-xs text-gray-400 mt-0.5 truncate">
                {activeSession.keyword} in {activeSession.city}
              </div>
            )}
            {lastMessage && (
              <div className="text-xs text-gray-500 mt-0.5 truncate">{lastMessage}</div>
            )}
          </div>
          {isRunning && (
            <div className="shrink-0 text-right">
              <div className="text-lg font-bold text-green-400">{totalCaptured}</div>
              <div className="text-xs text-gray-500">captured</div>
            </div>
          )}
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Leads Captured"
          value={totalCaptured}
          sub={isRunning ? 'Live' : 'This session'}
          accent="text-blue-400"
          icon="⌕"
          tint="from-blue-500/12"
        />
        <StatCard
          label="Duplicates Skipped"
          value={duplicatesSkipped}
          sub="This session"
          accent="text-amber-400"
          icon="⧉"
          tint="from-amber-500/12"
        />
        <StatCard
          label="Total Sessions"
          value={totalSessions}
          sub={`${completedSessions} completed`}
          accent="text-violet-400"
          icon="◱"
          tint="from-violet-500/12"
        />
        <StatCard
          label="Session Status"
          value={sessionId ? status.replace('_', ' ') : 'Idle'}
          sub={activeSession ? `ID #${activeSession.id}` : 'No active session'}
          accent={isRunning ? 'text-emerald-400' : 'text-gray-400'}
          icon="◉"
          tint={isRunning ? 'from-emerald-500/12' : 'from-gray-500/6'}
        />
      </div>
    </div>
  )
}
