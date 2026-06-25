import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  message: string
  type: ToastType
  undoFn?: () => void
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, type?: ToastType, undoFn?: () => void) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  show(message, type = 'success', undoFn) {
    const id = Math.random().toString(36).slice(2, 9)
    set((s) => ({ toasts: [...s.toasts, { id, message, type, undoFn }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, undoFn ? 5000 : 3500)
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export const toast = {
  success: (msg: string) => useToastStore.getState().show(msg, 'success'),
  error:   (msg: string) => useToastStore.getState().show(msg, 'error'),
  info:    (msg: string, undoFn?: () => void) => useToastStore.getState().show(msg, 'info', undoFn),
  warning: (msg: string) => useToastStore.getState().show(msg, 'warning'),
}
