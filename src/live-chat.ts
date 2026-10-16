import { WebChatAgentError } from './errors.js'
import { asString, isObject, parseFile, systemEvent, toIsoDate, type JsonObject } from './parse.js'
import type {
  ChatMode,
  LiveChatEndReason,
  LiveChatEvents,
  LiveChatMessage,
  LiveChatState,
  UploadedFile,
  WebSocketConstructorLike,
  WebSocketLike,
} from './types.js'

/** @internal What `LiveChat` needs from the client. */
export interface LiveChatContext {
  readonly url: string
  readonly baseUrl: string
  readonly chatbotId: string
  readonly sessionId: string
  readonly language: string | undefined
  readonly WebSocket: WebSocketConstructorLike
  end(): Promise<void>
  upload(file: Blob, name: string | undefined): Promise<UploadedFile>
}

type Listeners = { [K in keyof LiveChatEvents]: Set<(payload: LiveChatEvents[K]) => void> }

interface PendingEcho {
  text: string
  resolve: (message: LiveChatMessage) => void
  reject: (error: WebChatAgentError) => void
  timer: ReturnType<typeof setTimeout>
}

const OPEN = 1
// ponytail: fixed delay like the official widget, exponential backoff if servers ever get hammered.
const RECONNECT_DELAY_MS = 3000
const ECHO_TIMEOUT_MS = 15000

/**
 * Real-time chat with a human team member. Create it with `chat.liveChat()`.
 *
 * @example
 * const live = chat.liveChat()
 * live.on('message', (m) => render(m))
 * live.on('ended', () => showNotice('The chat has ended.'))
 * await live.send('Hello?')
 */
export class LiveChat {
  readonly #ctx: LiveChatContext
  readonly #listeners: Listeners = {
    ready: new Set(),
    message: new Set(),
    status: new Set(),
    typing: new Set(),
    ended: new Set(),
    disconnected: new Set(),
  }
  #socket: WebSocketLike | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #pending: PendingEcho[] = []
  #status: LiveChatState | null = null
  #ready = false
  #ended = false
  #closed = false

  /** @internal Use `chat.liveChat()`. */
  constructor(ctx: LiveChatContext) {
    this.#ctx = ctx
    this.#connect()
  }

  /** Last state reported by the server, `null` until known. */
  get status(): LiveChatState | null {
    return this.#status
  }

  /** Connected and joined; `send()` works. */
  get ready(): boolean {
    return this.#ready
  }

  /** `false` after the chat ended or `close()` was called. Get a fresh instance from `chat.liveChat()`. */
  get active(): boolean {
    return !this.#ended && !this.#closed
  }

  /**
   * Subscribe to an event. Returns a function that unsubscribes.
   *
   * @example
   * const off = live.on('typing', (isTyping) => setAgentTyping(isTyping))
   * off()
   */
  on<K extends keyof LiveChatEvents>(event: K, listener: (payload: LiveChatEvents[K]) => void): () => void {
    this.#listeners[event].add(listener)
    return () => {
      this.#listeners[event].delete(listener)
    }
  }

  /**
   * Send a message to the team member. Resolves with the server's copy of the message,
   * which also arrives as a `message` event. Rejects with `LIVE_CHAT_INACTIVE`
   * unless a handover is waiting or open (see `chat.requestHuman()`).
   */
  send(text: string): Promise<LiveChatMessage> {
    const content = text.trim()
    if (!content) return Promise.reject(new WebChatAgentError('Message is empty.', { code: 'INVALID_INPUT' }))
    const inactive = this.#inactiveError()
    if (inactive) return Promise.reject(inactive)
    if (!this.#sendFrame({ type: 'client:message', sender: 'user', content })) {
      return Promise.reject(new WebChatAgentError('Not connected. Wait for the ready event and try again.', { code: 'NETWORK' }))
    }
    return new Promise((resolve, reject) => {
      const pending: PendingEcho = {
        text: content,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#pending = this.#pending.filter((p) => p !== pending)
          reject(new WebChatAgentError('The message was not confirmed in time. It may still arrive.', { code: 'TIMEOUT' }))
        }, ECHO_TIMEOUT_MS),
      }
      this.#pending.push(pending)
    })
  }

  /** Tell the team member whether the visitor is typing. */
  typing(isTyping: boolean): void {
    this.#sendFrame({ type: 'client:typing', sender: 'user', isTyping })
  }

  /** Send a file (max 5 MB) to the team member. It also arrives as a `message` event with `file`. */
  upload(file: Blob, name?: string): Promise<UploadedFile> {
    const inactive = this.#inactiveError()
    return inactive ? Promise.reject(inactive) : this.#ctx.upload(file, name)
  }

  /** End the live chat for both sides. The bot answers again afterwards. */
  async end(): Promise<void> {
    if (this.#ended) return
    await this.#ctx.end()
    this.#finish('user_closed')
  }

  /** Disconnect without ending the live chat, e.g. when your chat UI unmounts. */
  close(): void {
    this.#closed = true
    this.#shutdown()
  }

  #inactiveError(): WebChatAgentError | null {
    if (this.active && (this.#status === 'waiting' || this.#status === 'open')) return null
    return new WebChatAgentError('No live chat is waiting or open. Call requestHuman() first.', { code: 'LIVE_CHAT_INACTIVE' })
  }

  #emit<K extends keyof LiveChatEvents>(event: K, payload: LiveChatEvents[K]): void {
    for (const listener of this.#listeners[event]) listener(payload)
  }

  #connect(): void {
    let socket: WebSocketLike
    try {
      socket = new this.#ctx.WebSocket(this.#ctx.url)
    } catch {
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    socket.onopen = () => {
      const lang = this.#ctx.language
      this.#sendFrame({ type: 'client:join', as: 'user', ...(lang ? { lang } : {}) })
      this.#sendFrame({ type: 'client:meta', ...pageMeta() })
    }
    socket.onmessage = (event: { data: unknown }) => {
      if (typeof event.data === 'string') this.#handle(event.data)
    }
    socket.onerror = () => undefined // a close event follows
    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#ready = false
      if (!this.active) return
      this.#emit('disconnected', undefined)
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect(): void {
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = setTimeout(() => {
      if (this.active) this.#connect()
    }, RECONNECT_DELAY_MS)
  }

  #sendFrame(frame: JsonObject): boolean {
    const socket = this.#socket
    if (!socket || socket.readyState !== OPEN) return false
    // The server silently drops frames without chatbotId and sessionId.
    socket.send(JSON.stringify({ ...frame, chatbotId: this.#ctx.chatbotId, sessionId: this.#ctx.sessionId }))
    return true
  }

  #handle(data: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!isObject(frame)) return
    switch (frame['type']) {
      case 'livechat:status':
        return this.#handleStatus(frame)
      case 'livechat:message': {
        if (frame['audience'] === 'admin') return // copies meant for the team member
        const message = toLiveChatMessage(frame, this.#ctx.baseUrl)
        if (!message) return
        if (message.role === 'user') this.#resolveEcho(message)
        return this.#emit('message', message)
      }
      case 'livechat:typing':
        if (frame['sender'] === 'admin') this.#emit('typing', frame['isTyping'] === true)
        return
      case 'livechat:ended':
        return this.#finish(toEndReason(frame['reason']))
      default:
        return
    }
  }

  #handleStatus(frame: JsonObject): void {
    if (frame['ok'] === true) {
      this.#ready = true
      return this.#emit('ready', undefined)
    }
    const status = frame['status']
    if (status !== 'waiting' && status !== 'open' && status !== 'closed') return
    const mode: ChatMode = frame['mode'] === 'human' ? 'human' : 'bot'
    this.#status = status
    this.#emit('status', { status, mode })
    // While joining, a closed session is followed by `ended: already_closed`.
    // Once joined, the server may close a waiting chat with a status update only.
    if (status === 'closed' && this.#ready) this.#finish('closed')
  }

  #resolveEcho(message: LiveChatMessage): void {
    const pending = this.#pending.find((p) => p.text === message.text)
    if (!pending) return
    this.#pending = this.#pending.filter((p) => p !== pending)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  #finish(reason: LiveChatEndReason): void {
    if (this.#ended) return
    this.#ended = true
    this.#status = 'closed'
    this.#emit('ended', { reason })
    this.#shutdown()
  }

  #shutdown(): void {
    clearTimeout(this.#reconnectTimer)
    const error = new WebChatAgentError('The live chat is no longer active.', { code: 'LIVE_CHAT_INACTIVE' })
    for (const pending of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending = []
    this.#ready = false
    const socket = this.#socket
    this.#socket = null
    socket?.close()
  }
}

function toEndReason(value: unknown): LiveChatEndReason {
  return value === 'user_closed' || value === 'admin_closed' || value === 'already_closed' ? value : 'closed'
}

function toLiveChatMessage(frame: JsonObject, baseUrl: string): LiveChatMessage | null {
  const sender = frame['sender']
  const role = sender === 'user' ? 'user' : sender === 'admin' ? 'agent' : sender === 'system' ? 'system' : null
  if (!role) return null
  const content = asString(frame['content'])
  const event = role === 'system' ? systemEvent(content) : null
  return {
    id: typeof frame['id'] === 'number' ? frame['id'] : null,
    role,
    text: event ? '' : content,
    file: parseFile(frame['file'], baseUrl),
    event,
    createdAt: toIsoDate(frame['createdAt']),
  }
}

/** Page context shown to the team member. Empty outside browsers. */
function pageMeta(): JsonObject {
  return {
    ...(typeof location === 'undefined' ? {} : { pageUrl: location.href }),
    ...(typeof document === 'undefined' ? {} : { pageTitle: document.title }),
    ...(typeof navigator === 'undefined' || !navigator.language ? {} : { browserLanguage: navigator.language }),
  }
}
