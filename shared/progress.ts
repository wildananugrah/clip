/**
 * Progress transport: the worker writes the row then NOTIFYs; the backend holds
 * one LISTEN connection and fans out to SSE subscribers.
 *
 * The row is the source of truth and the notify is only a wake-up, which is what
 * makes a mid-job browser refresh resume correctly -- the thing the prototype's
 * persist.ts apologises for being unable to do.
 */
import type { ProgressEvent } from './types.ts'

export const NOTIFY_CHANNEL = 'job_progress'
export const CANCEL_CHANNEL = 'job_cancel'

/**
 * Postgres caps a NOTIFY payload at 8000 bytes. Progress payloads are tiny, but
 * an error string is attacker-adjacent (it can contain a whole ffmpeg dump), so
 * truncate rather than risk the NOTIFY failing and stalling the UI.
 */
export function encodeProgress(e: ProgressEvent): string {
  const safe: ProgressEvent = { ...e, error: e.error ? e.error.slice(0, 500) : null }
  return JSON.stringify(safe)
}

export function decodeProgress(payload: string): ProgressEvent | null {
  try {
    return JSON.parse(payload) as ProgressEvent
  } catch {
    return null
  }
}
