import React from 'react'
import type { NavSection } from './Sidebar'
import { useCaptureStore } from '@/state/useCaptureStore'

const TITLES: Record<NavSection, string> = {
  overview:         'Overview',
  search:           'Search Console',
  leads:            'Lead Database',
  selected:         'Selected Leads',
  research:         'Research Queue',
  research_results: 'Research Results',
  analytics:        'Analytics',
  import:           'Import CSV',
  backup:           'Backup & Restore',
  logs:             'Activity Logs',
  settings:         'Settings',
}

interface TopbarProps {
  section: NavSection
}

const STATUS_COLORS: Record<string, string> = {
  idle:         'bg-gray-600 text-gray-300',
  opening_maps: 'bg-yellow-700 text-yellow-200',
  running:      'bg-green-700 text-green-200',
  stopped:      'bg-red-800 text-red-200',
  completed:    'bg-blue-800 text-blue-200',
  error:        'bg-red-900 text-red-200',
}

export default function Topbar({ section }: TopbarProps) {
  const { status, totalCaptured, sessionId, lastMessage } = useCaptureStore()
  const isActive = status === 'running' || status === 'opening_maps'

  return (
    <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-5 gap-4 shrink-0">
      <h1 className="text-base font-semibold text-white">{TITLES[section]}</h1>

      {/* Live capture pill */}
      {sessionId && (
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? STATUS_COLORS.idle}`}>
          {isActive && <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />}
          {status === 'running' ? `Capturing — ${totalCaptured} leads` :
           status === 'opening_maps' ? 'Opening Maps...' :
           status === 'completed' ? `Done — ${totalCaptured} leads` :
           status === 'stopped' ? 'Stopped' :
           lastMessage || status}
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        <span className="text-xs text-gray-600">{new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</span>
      </div>
    </header>
  )
}
