const PREFIX = '[LeadScout]'

let debugEnabled = false

export function setDebugMode(enabled: boolean) {
  debugEnabled = enabled
}

export const logger = {
  info(msg: string, ...args: unknown[]) {
    console.info(`${PREFIX} ${msg}`, ...args)
  },
  warn(msg: string, ...args: unknown[]) {
    console.warn(`${PREFIX} ${msg}`, ...args)
  },
  error(msg: string, ...args: unknown[]) {
    console.error(`${PREFIX} ${msg}`, ...args)
  },
  debug(msg: string, ...args: unknown[]) {
    if (debugEnabled) console.debug(`${PREFIX}[DEBUG] ${msg}`, ...args)
  },
}
