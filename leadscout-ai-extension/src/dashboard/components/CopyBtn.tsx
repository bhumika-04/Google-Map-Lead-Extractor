import React, { useState } from 'react'

interface CopyBtnProps {
  value: string
  className?: string
  label?: string
}

export default function CopyBtn({ value, className = '', label }: CopyBtnProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation()
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      title={`Copy ${label ?? value}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors
        ${copied
          ? 'bg-green-900 text-green-300'
          : 'bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white'
        } ${className}`}
    >
      {copied ? '✓' : '⎘'}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  )
}
