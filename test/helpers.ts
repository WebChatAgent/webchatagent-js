import { vi } from 'vitest'
import type { FetchLike, WebSocketLike } from '../src/index.js'

export const CHATBOT_ID = '11111111-2222-4333-8444-555555555555'
export const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

export interface Call {
  url: string
  init: RequestInit
}

/** fetch mock that answers each call with the next response factory. */
export function mockFetch(...responses: Array<() => Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error(`Unexpected fetch ${url}`)
    return next()
  })
  return Object.assign(fn, { calls })
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** SSE response whose body is delivered in the given byte chunks. */
export function sse(chunks: Array<string | Uint8Array>, onCancel?: () => void): () => Response {
  return () => {
    const encoder = new TextEncoder()
    let index = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++]
        if (chunk === undefined) controller.close()
        else controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      },
      cancel() {
        onCancel?.()
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
}

export function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>
}

export function bodyOf(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init.body))
}

/** In-memory WebSocket that records sent frames and lets tests push server frames. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: ((event: never) => void) | null = null
  onmessage: ((event: never) => void) | null = null
  onclose: ((event: never) => void) | null = null
  onerror: ((event: never) => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1)
    if (!socket) throw new Error('no socket')
    return socket
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    ;(this.onopen as ((event: unknown) => void) | null)?.({})
  }

  receive(frame: Record<string, unknown>): void {
    ;(this.onmessage as ((event: { data: string }) => void) | null)?.({ data: JSON.stringify(frame) })
  }

  drop(): void {
    this.readyState = 3
    ;(this.onclose as ((event: unknown) => void) | null)?.({})
  }
}
