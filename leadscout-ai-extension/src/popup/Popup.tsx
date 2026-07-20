import React, { useEffect, useState } from 'react'
import { MSG } from '@/types/messages'

interface ActiveSession {
  sessionId: number
  city: string
  keyword: string
  totalCaptured: number
  duplicatesSkipped: number
  status: string
  maxResults: number
}

export default function Popup() {
  const [session, setSession] = useState<ActiveSession | null>(null)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    chrome.runtime.sendMessage({ type: MSG.GET_STATUS })
      .then((res: any) => { if (res?.activeSession) setSession(res.activeSession) })
      .catch(() => {})
  }, [])

  function openDashboard() {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') }).catch(() => {})
    window.close()
  }

  async function handleStop() {
    setStopping(true)
    await chrome.runtime.sendMessage({ type: MSG.CAPTURE_STOP })
    setStopping(false)
    setSession(null)
  }

  const pct = session && session.maxResults > 0
    ? Math.min(100, Math.round((session.totalCaptured / session.maxResults) * 100))
    : 0

  const isRunning = session?.status === 'running' || session?.status === 'opening_maps'

  return (
    <div className="bg-gray-950 text-white flex flex-col" style={{ width: 320 }}>

      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-gray-900 border-b border-gray-800">
        <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center text-xs font-bold shadow-md shadow-blue-900/50">
          LS
        </div>
        <div className="flex-1">
          <div className="font-semibold text-sm text-white leading-none">LeadScout AI</div>
          <div className="text-xs text-blue-400 leading-none mt-0.5">Business Lead Discovery</div>
        </div>
        <span className="text-xs text-gray-600">v1.0</span>
      </div>

      <div className="p-4 space-y-3">

        {/* Active session card */}
        {session ? (
          <div className={`rounded-xl border p-3.5 space-y-3 ${
            isRunning ? 'bg-green-950/60 border-green-800' : 'bg-gray-900 border-gray-700'
          }`}>
            {/* Status indicator */}
            <div className="flex items-center gap-2">
              {isRunning && <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse shrink-0" />}
              <span className={`text-sm font-semibold ${isRunning ? 'text-green-400' : 'text-gray-300'}`}>
                {session.status === 'opening_maps' ? 'Opening Google Maps...' :
                 session.status === 'running'      ? 'Capture Running' :
                 session.status === 'completed'    ? 'Capture Completed' :
                 session.status === 'stopped'      ? 'Capture Stopped' : session.status}
              </span>
            </div>

            {/* Search info */}
            <div className="text-xs text-gray-400">
              <span className="text-white font-medium">{session.keyword}</span>
              <span className="text-gray-600"> in </span>
              <span className="text-gray-300 font-medium">{session.city}</span>
            </div>

            {/* Stats row */}
            <div className="flex gap-4 text-xs">
              <div>
                <div className="text-white font-bold text-lg leading-none">{session.totalCaptured}</div>
                <div className="text-gray-500 text-xs">captured</div>
              </div>
              <div>
                <div className="text-yellow-400 font-bold text-lg leading-none">{session.duplicatesSkipped}</div>
                <div className="text-gray-500 text-xs">duplicates</div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-gray-400 font-bold text-lg leading-none">{session.maxResults}</div>
                <div className="text-gray-600 text-xs">max</div>
              </div>
            </div>

            {/* Progress bar */}
            {session.maxResults > 0 && (
              <div className="space-y-1">
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${isRunning ? 'bg-blue-500' : 'bg-gray-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-right text-xs text-gray-600">{pct}%</div>
              </div>
            )}

            {/* Stop button */}
            {isRunning && (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="w-full py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs
                  font-semibold rounded-lg transition-colors"
              >
                {stopping ? 'Stopping...' : 'Stop Capture'}
              </button>
            )}
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <div className="text-2xl mb-1 opacity-30">⌕</div>
            <div className="text-sm text-gray-500">No active capture</div>
            <div className="text-xs text-gray-700 mt-1">Open dashboard to start a search</div>
          </div>
        )}

        {/* Open dashboard — primary CTA */}
        <button
          onClick={openDashboard}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm
            font-semibold rounded-xl transition-colors shadow-sm shadow-blue-900/40"
        >
          Open Dashboard
        </button>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-800 text-center">
        <span className="text-xs text-gray-700">All data stored locally · No backend</span>
      </div>
    </div>
  )
}
