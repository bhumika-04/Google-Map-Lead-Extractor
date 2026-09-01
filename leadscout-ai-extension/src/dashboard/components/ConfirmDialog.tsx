import React, { useEffect } from 'react'
import { useConfirmStore } from '@/state/useConfirmStore'

// Mounted once at the app root (Dashboard.tsx), same pattern as ToastContainer.
// Renders nothing until something calls confirmDialog(); then shows one
// centered, themed dialog in place of window.confirm().
export default function ConfirmDialog() {
  const { request, resolveActive } = useConfirmStore()

  useEffect(() => {
    if (!request) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') resolveActive(false)
      if (e.key === 'Enter') resolveActive(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [request, resolveActive])

  if (!request) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 animate-fade-in-up"
      onClick={() => resolveActive(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-5"
      >
        {request.title && <h3 className="text-sm font-semibold text-white mb-2">{request.title}</h3>}
        <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{request.message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => resolveActive(false)}
            className="text-xs px-4 py-2 rounded-lg font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            onClick={() => resolveActive(true)}
            autoFocus
            className={`text-xs px-4 py-2 rounded-lg font-medium text-white transition-colors ${
              request.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
