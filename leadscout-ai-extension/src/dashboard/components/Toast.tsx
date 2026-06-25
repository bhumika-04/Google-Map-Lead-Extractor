import React, { useEffect, useState } from 'react'
import { useToastStore, type ToastType } from '@/state/useToastStore'

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  info:    'ℹ',
  warning: '⚠',
}

const STYLES: Record<ToastType, string> = {
  success: 'bg-green-900 border-green-700 text-green-100',
  error:   'bg-red-900 border-red-700 text-red-100',
  info:    'bg-blue-900 border-blue-700 text-blue-100',
  warning: 'bg-yellow-900 border-yellow-700 text-yellow-100',
}

const ICON_STYLES: Record<ToastType, string> = {
  success: 'text-green-400',
  error:   'text-red-400',
  info:    'text-blue-400',
  warning: 'text-yellow-400',
}

function ToastItem({ id, message, type, undoFn }: { id: string; message: string; type: ToastType; undoFn?: () => void }) {
  const { dismiss } = useToastStore()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(t)
  }, [])

  function handleUndo() {
    undoFn?.()
    dismiss(id)
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-xl text-sm font-medium
        transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}
        ${STYLES[type]}`}
      style={{ minWidth: 260, maxWidth: 400 }}
    >
      <span className={`text-base shrink-0 ${ICON_STYLES[type]}`}>{ICONS[type]}</span>
      <span className="flex-1 leading-snug">{message}</span>
      {undoFn && (
        <button
          onClick={handleUndo}
          className="px-2.5 py-1 bg-white/20 hover:bg-white/30 rounded-lg text-xs font-semibold transition-colors shrink-0"
        >
          Undo
        </button>
      )}
      <button
        onClick={() => dismiss(id)}
        className="opacity-50 hover:opacity-100 transition-opacity text-base leading-none shrink-0"
      >
        ×
      </button>
    </div>
  )
}

export default function ToastContainer() {
  const { toasts } = useToastStore()
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem {...t} />
        </div>
      ))}
    </div>
  )
}
