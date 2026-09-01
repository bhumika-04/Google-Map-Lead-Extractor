import { create } from 'zustand'

// Promise-based replacement for window.confirm() — window.confirm renders as
// an unstyled OS-native dialog outside the page's control (can't be themed,
// doesn't match light/dark mode, and blocks the whole browser process).
// confirmDialog() shows an in-page, centered dialog instead and resolves the
// same way confirm() would: true if the user confirmed, false otherwise.

interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean   // red confirm button, for destructive actions
}

interface ConfirmRequest extends ConfirmOptions {
  id: string
  message: string
  resolve: (ok: boolean) => void
}

interface ConfirmState {
  request: ConfirmRequest | null
  ask: (message: string, opts?: ConfirmOptions) => Promise<boolean>
  resolveActive: (ok: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,

  ask(message, opts) {
    return new Promise<boolean>((resolve) => {
      const id = Math.random().toString(36).slice(2, 9)
      set({ request: { id, message, resolve, ...opts } })
    })
  },

  resolveActive(ok) {
    const { request } = get()
    if (!request) return
    request.resolve(ok)
    set({ request: null })
  },
}))

export function confirmDialog(message: string, opts?: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(message, opts)
}
