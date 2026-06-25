import React, { useEffect, useState, useCallback } from 'react'
import { activityLogRepository } from '@/db/activityLogRepository'
import type { ActivityLog } from '@/db/db'
import { timeAgo } from '@/utils/date'
import { MSG } from '@/types/messages'

const LOG_ICON: Record<string, string> = {
  search_started:         '⌕',
  maps_tab_opened:        '⊕',
  capture_started:        '▶',
  lead_captured:          '●',
  duplicate_skipped:      '◈',
  lead_updated:           '✎',
  capture_stopped:        '■',
  search_completed:       '✓',
  lead_selected:          '★',
  lead_rejected:          '✗',
  lead_added_to_research: '⚗',
  export_completed:       '↓',
  capture_error:          '!',
  system:                 '◉',
}

const LOG_COLOR: Record<string, string> = {
  search_started:         'text-blue-400',
  maps_tab_opened:        'text-cyan-400',
  capture_started:        'text-green-400',
  lead_captured:          'text-green-300',
  duplicate_skipped:      'text-yellow-400',
  capture_stopped:        'text-orange-400',
  search_completed:       'text-blue-300',
  lead_selected:          'text-emerald-400',
  lead_rejected:          'text-red-400',
  lead_added_to_research: 'text-purple-400',
  export_completed:       'text-teal-400',
  capture_error:          'text-red-500',
  system:                 'text-gray-400',
}

export default function ActivityLogPanel() {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchLogs = useCallback(async () => {
    const data = await activityLogRepository.getAll(300)
    setLogs(data)
  }, [])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(fetchLogs, 2000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchLogs])

  // Also listen for progress updates to trigger a refresh
  useEffect(() => {
    const handler = (msg: { type: string }) => {
      if (msg.type === MSG.PROGRESS_UPDATE) fetchLogs()
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [fetchLogs])

  async function handleClear() {
    await activityLogRepository.clear()
    setLogs([])
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold text-white text-sm">Activity Logs</h2>
        <span className="text-xs text-gray-600">{logs.length} entries</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-blue-500" />
            Auto-refresh
          </label>
          <button onClick={fetchLogs} className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors">Refresh</button>
          <button onClick={handleClear} className="text-xs px-2 py-1 bg-red-950 hover:bg-red-900 text-red-300 rounded transition-colors">Clear</button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-gray-950 border border-gray-800 rounded-xl p-3 font-mono">
        {logs.length === 0 ? (
          <div className="text-gray-700 text-xs text-center py-8">No activity logs yet</div>
        ) : (
          <div className="space-y-1">
            {logs.map((log) => {
              const icon = LOG_ICON[log.type] ?? '·'
              const color = LOG_COLOR[log.type] ?? 'text-gray-400'
              return (
                <div key={log.id} className="flex items-start gap-2 text-xs">
                  <span className={`${color} shrink-0 w-4 text-center`}>{icon}</span>
                  <span className="text-gray-600 shrink-0 w-16 text-right">{timeAgo(log.createdAt)}</span>
                  <span className="text-gray-400 flex-1 min-w-0">{log.message}</span>
                  {log.sessionId && (
                    <span className="text-gray-700 shrink-0">#{log.sessionId}</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
