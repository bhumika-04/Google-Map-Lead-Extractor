import React from 'react'
import { useCaptureStore } from '@/state/useCaptureStore'
import { useSearchStore } from '@/state/useSearchStore'

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  accent?: string
}

function StatCard({ label, value, sub, accent = 'text-white' }: StatCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold ${accent}`}>{value}</span>
      {sub && <span className="text-xs text-gray-600">{sub}</span>}
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
        />
        <StatCard
          label="Duplicates Skipped"
          value={duplicatesSkipped}
          sub="This session"
          accent="text-yellow-400"
        />
        <StatCard
          label="Total Sessions"
          value={totalSessions}
          sub={`${completedSessions} completed`}
          accent="text-purple-400"
        />
        <StatCard
          label="Session Status"
          value={sessionId ? status.replace('_', ' ') : 'Idle'}
          sub={activeSession ? `ID #${activeSession.id}` : 'No active session'}
          accent={isRunning ? 'text-green-400' : 'text-gray-400'}
        />
      </div>
    </div>
  )
}
