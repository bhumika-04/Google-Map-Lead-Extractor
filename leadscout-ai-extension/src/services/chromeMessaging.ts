import type { ExtMessage, MessageType } from '@/types/messages'

export function sendToBackground<T = unknown>(message: ExtMessage<T>): Promise<unknown> {
  return chrome.runtime.sendMessage(message)
}

export function sendToTab<T = unknown>(tabId: number, message: ExtMessage<T>): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message)
}

export function onMessage(
  handler: (msg: ExtMessage, sender: chrome.runtime.MessageSender, respond: (r?: unknown) => void) => void | boolean
) {
  chrome.runtime.onMessage.addListener(handler)
}

export function broadcastToAllTabs<T = unknown>(message: ExtMessage<T>): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {})
      }
    }
  })
}

export function openDashboard(): void {
  const url = chrome.runtime.getURL('dashboard/dashboard.html')
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length > 0 && tabs[0].id) {
      chrome.tabs.update(tabs[0].id, { active: true })
      chrome.windows.update(tabs[0].windowId!, { focused: true })
    } else {
      chrome.tabs.create({ url })
    }
  })
}
