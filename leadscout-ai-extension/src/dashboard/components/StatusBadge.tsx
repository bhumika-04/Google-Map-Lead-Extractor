import React from 'react'
import type { LeadStatus } from '@/types/lead'
import type { SessionStatus } from '@/types/searchSession'
import type { ResearchJobStatus } from '@/types/research'

type AnyStatus = LeadStatus | SessionStatus | ResearchJobStatus

const BADGE_MAP: Record<string, { label: string; cls: string }> = {
  // Lead statuses
  new:                { label: 'New',              cls: 'bg-blue-900 text-blue-300 border-blue-800' },
  selected:           { label: 'Selected',         cls: 'bg-green-900 text-green-300 border-green-800' },
  rejected:           { label: 'Rejected',         cls: 'bg-red-900 text-red-300 border-red-800' },
  research_pending:   { label: 'Research Pending', cls: 'bg-yellow-900 text-yellow-300 border-yellow-800' },
  research_running:   { label: 'Researching',      cls: 'bg-purple-900 text-purple-300 border-purple-800' },
  research_completed: { label: 'Researched',       cls: 'bg-teal-900 text-teal-300 border-teal-800' },
  research_failed:    { label: 'Research Failed',  cls: 'bg-red-950 text-red-400 border-red-900' },
  // Session statuses
  idle:               { label: 'Idle',             cls: 'bg-gray-800 text-gray-400 border-gray-700' },
  opening_maps:       { label: 'Opening Maps',     cls: 'bg-yellow-900 text-yellow-300 border-yellow-800' },
  running:            { label: 'Running',          cls: 'bg-green-900 text-green-300 border-green-800' },
  paused:             { label: 'Paused',           cls: 'bg-orange-900 text-orange-300 border-orange-800' },
  completed:          { label: 'Completed',        cls: 'bg-blue-900 text-blue-300 border-blue-800' },
  stopped:            { label: 'Stopped',          cls: 'bg-red-900 text-red-300 border-red-800' },
  error:              { label: 'Error',            cls: 'bg-red-950 text-red-400 border-red-900' },
  // Research job
  pending:            { label: 'Pending',          cls: 'bg-yellow-900 text-yellow-300 border-yellow-800' },
  failed:             { label: 'Failed',           cls: 'bg-red-900 text-red-300 border-red-800' },
  cancelled:          { label: 'Cancelled',        cls: 'bg-gray-800 text-gray-400 border-gray-700' },
}

interface StatusBadgeProps {
  status: AnyStatus
  size?: 'sm' | 'xs'
}

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const badge = BADGE_MAP[status] ?? { label: status, cls: 'bg-gray-800 text-gray-400 border-gray-700' }
  const textSize = size === 'xs' ? 'text-xs' : 'text-xs'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border font-medium ${textSize} ${badge.cls}`}>
      {badge.label}
    </span>
  )
}
