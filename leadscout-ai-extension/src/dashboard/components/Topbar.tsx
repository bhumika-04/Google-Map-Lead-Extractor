import React, { useEffect, useState } from 'react'
import type { NavSection } from './Sidebar'
import { useCaptureStore } from '@/state/useCaptureStore'
import type { PipelinePhase } from '@/state/useCaptureStore'
import { useSettingsStore } from '@/state/useSettingsStore'
import { isApiAvailable } from '@/services/sqlSyncService'
import PipelineControl from './PipelineControl'
import SessionSwitcher from './SessionSwitcher'

const TITLES: Record<NavSection, string> = {
  overview:             'Overview',
  search:               'Search Console',
  batch_campaigns:      'Batch Campaigns',
  leads:                'Lead Database',
  selected:             'Selected Leads',
  research:             'Research Queue',
  research_results:     'Research Results',
  company_intelligence: 'Company Intelligence',
  linkedin_intelligence: 'LinkedIn Intelligence',
  markets:               'Markets',
  followups:            'Follow-Ups',
  nurture:              'Nurture',
  analytics:            'Analytics',
  import:               'Import CSV',
  existing_clients:     'Existing Clients',
  backup:               'Backup & Restore',
  logs:                 'Activity Logs',
  settings:             'Settings',
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

const PIPELINE_LABELS: Record<NonNullable<PipelinePhase>, string> = {
  maps_capture_running:      'Maps Capture Running',
  maps_capture_completed:    'Maps Capture Complete',
  quick_enrichment_running:  'AI Enrichment…',
  validation_running:        'Validating Leads…',
  validation_completed:      'Validation Complete',
  research_queued:           'Research Queued',
  research_running:          'Research Running',
  research_completed:        'Research Complete',
}

const PIPELINE_COLORS: Record<NonNullable<PipelinePhase>, string> = {
  maps_capture_running:      'bg-blue-700 text-blue-200',
  maps_capture_completed:    'bg-blue-800 text-blue-200',
  quick_enrichment_running:  'bg-purple-700 text-purple-200',
  validation_running:        'bg-yellow-700 text-yellow-200',
  validation_completed:      'bg-green-800 text-green-200',
  research_queued:           'bg-orange-700 text-orange-200',
  research_running:          'bg-indigo-700 text-indigo-200',
  research_completed:        'bg-teal-700 text-teal-200',
}

export default function Topbar({ section }: TopbarProps) {
  const { status, pipelinePhase, totalCaptured, sessionId, lastMessage } = useCaptureStore()
  const { settings, update } = useSettingsStore()
  const isActive = status === 'running' || status === 'opening_maps'
  const isLight = settings.theme === 'light'
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const isPipelineActive = pipelinePhase !== null && pipelinePhase !== 'research_completed'

  useEffect(() => {
    let cancelled = false
    async function check() {
      const ok = await isApiAvailable()
      if (!cancelled) setApiOnline(ok)
    }
    check()
    const interval = setInterval(check, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  function toggleTheme() {
    update({ theme: isLight ? 'dark' : 'light' })
  }

  return (
    <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-5 gap-4 shrink-0">
      <h1 className="text-base font-semibold text-white">{TITLES[section]}</h1>

      {/* Global Search Session scope — filters every page */}
      <SessionSwitcher />

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

      {/* Post-capture pipeline phase pill */}
      {isPipelineActive && pipelinePhase && (
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${PIPELINE_COLORS[pipelinePhase]}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          {PIPELINE_LABELS[pipelinePhase]}
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        {/* Background pipeline status + Stop/Re-run (accurate on any page) */}
        <PipelineControl />

        {/* API health indicator */}
        <div className="flex items-center gap-1.5 text-xs" title={apiOnline === null ? 'Checking API…' : apiOnline ? 'DeepLead API online' : 'DeepLead API offline — start the API server'}>
          <span className={`w-2 h-2 rounded-full ${apiOnline === null ? 'bg-gray-600' : apiOnline ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          <span className={apiOnline === false ? 'text-red-400' : 'text-gray-600'}>
            {apiOnline === null ? 'API…' : apiOnline ? 'API' : 'API offline'}
          </span>
        </div>

        <span className="text-xs text-gray-600">
          {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}
        </span>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
          className="px-2.5 h-8 flex items-center justify-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors text-xs font-medium"
        >
          {isLight ? 'Dark' : 'Light'}
        </button>
      </div>
    </header>
  )
}
