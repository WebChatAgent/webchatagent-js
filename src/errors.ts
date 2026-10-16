import type { WebChatAgentErrorCode } from './types.js'

/**
 * Every failure of the SDK. `message` is plain text you can show to visitors.
 *
 * @example
 * try {
 *   await chat.send(text)
 * } catch (error) {
 *   if (error instanceof WebChatAgentError) showNotice(error.message)
 *   else throw error // e.g. AbortError from your own AbortController
 * }
 */
export class WebChatAgentError extends Error {
  override readonly name = 'WebChatAgentError'
  /** What went wrong, see `WebChatAgentErrorCode`. */
  readonly code: WebChatAgentErrorCode
  /** HTTP status, `0` when there was no response. 429 means too many messages or the chat is unavailable right now. */
  readonly status: number
  /** Parsed response body, or details from the SDK (e.g. `{ missing, invalid }` field IDs for forms). */
  readonly body: unknown

  constructor(message: string, options: { code: WebChatAgentErrorCode; status?: number; body?: unknown; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = options.code
    this.status = options.status ?? 0
    this.body = options.body
  }
}
