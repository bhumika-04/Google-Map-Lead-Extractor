import React from 'react'
import { calculateLeadScore, scoreLabel, scoreColor } from '@/utils/leadScore'
import type { Lead } from '@/types/lead'

interface ScoreBadgeProps {
  lead: Lead
  showLabel?: boolean
  size?: 'xs' | 'sm'
}

export default function ScoreBadge({ lead, showLabel = false, size = 'xs' }: ScoreBadgeProps) {
  const score = calculateLeadScore(lead)
  const color = scoreColor(score)
  const label = scoreLabel(score)
  const pad   = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-xs'

  return (
    <span className={`inline-flex items-center gap-1 rounded border font-semibold leading-none ${pad} ${color}`}>
      <span>{score}</span>
      {showLabel && <span className="font-normal opacity-75">{label}</span>}
    </span>
  )
}
