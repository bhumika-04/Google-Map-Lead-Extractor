import React, { useEffect, useState } from 'react'
import type { ResearchResult } from '@/types/research'
import { researchResultRepository } from '@/db/researchResultRepository'
import CopyBtn from './CopyBtn'

interface Props {
  leadId: number
}

export default function ResearchResultCard({ leadId }: Props) {
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    researchResultRepository.getByLeadId(leadId).then((r) => {
      setResult(r ?? null)
      setLoading(false)
    })
  }, [leadId])

  if (loading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-3 bg-gray-800 rounded w-3/4" />
        <div className="h-3 bg-gray-800 rounded w-1/2" />
      </div>
    )
  }

  if (!result) return null

  const conf = Math.round(result.confidence * 100)
  const confColor = conf >= 75 ? 'text-green-400' : conf >= 50 ? 'text-yellow-400' : 'text-gray-500'

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">AI Research</div>
        <span className={`text-xs font-semibold ${confColor}`}>{conf}% confidence</span>
      </div>

      <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-3 space-y-3">

        {result.summary && (
          <p className="text-xs text-gray-300 leading-relaxed">{result.summary}</p>
        )}

        <div className="space-y-2">
          {result.decisionMaker && (
            <ResultRow icon="👤" label="Decision Maker" value={result.decisionMaker} />
          )}
          {result.email && (
            <ResultRow icon="✉" label="Email" value={result.email} copyable />
          )}
          {result.alternatePhone && (
            <ResultRow icon="☏" label="Alt Phone" value={result.alternatePhone} copyable />
          )}
          {result.linkedIn && (
            <div className="flex items-start gap-2">
              <span className="text-gray-600 shrink-0 text-xs mt-0.5">in</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-0.5">LinkedIn</div>
                <a
                  href={result.linkedIn}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 hover:underline truncate block transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  {result.linkedIn.replace(/^https?:\/\//, '')}
                </a>
              </div>
              <CopyBtn value={result.linkedIn} />
            </div>
          )}
        </div>

        {(result.services && result.services.length > 0) && (
          <div>
            <div className="text-xs text-gray-500 mb-1.5">Services</div>
            <div className="flex flex-wrap gap-1">
              {result.services.map((s) => (
                <span key={s} className="text-xs px-2 py-0.5 bg-gray-700 text-gray-300 rounded-full">{s}</span>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 text-xs text-gray-600 pt-1 border-t border-gray-700/50">
          {result.employeeCount && <span>👥 {result.employeeCount} employees</span>}
          {result.yearFounded   && <span>🗓 Founded {result.yearFounded}</span>}
          {result.sourceUrl     && (
            <a href={result.sourceUrl} target="_blank" rel="noreferrer"
              className="text-blue-700 hover:text-blue-500 transition-colors ml-auto"
              onClick={(e) => e.stopPropagation()}>
              source ↗
            </a>
          )}
        </div>
      </div>
    </section>
  )
}

function ResultRow({ icon, label, value, copyable }: {
  icon: string; label: string; value: string; copyable?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-600 shrink-0 text-xs mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-500 mb-0.5">{label}</div>
        <div className="text-xs text-gray-200 break-all">{value}</div>
      </div>
      {copyable && <CopyBtn value={value} />}
    </div>
  )
}
