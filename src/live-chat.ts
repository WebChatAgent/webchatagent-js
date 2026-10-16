import { WebChatAgentError } from './errors.js'
import {
  asString,
  browserLanguage,
  currentPageUrl,
  isObject,
  messageContent,
  parseFile,
  parseJson,
  toChatMode,
  toEndReason,
  toIsoDate,
  toLiveChatState,
  type JsonObject,
} from './parse.js'
import type {
  HistoryMessage,
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
  history(): Promise<HistoryMessage[]>
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
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000
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
  #reconnectAttempts = 0
  #pending: PendingEcho[] = []
  #status: LiveChatState | null = null
  #ready = false
  #ended = false
  #closed = false
  #typing = false
  /** Server message IDs already known to the visitor; `null` until the first join recorded them. */
  #seen: Set<number> | null = null

  /** @internal Use `chat.liveChat()`. */
  constructor(ctx: LiveChatContext) {
    this.#ctx = ctx
    this.#connect()
  }

  /** Last state reported by the server, `null` until known. */
  get status(): LiveChatState | null {
    return this.#status
  }

  /** Connected and joined. */
  get ready(): boolean {
    return this.#ready
  }

  /** `false` after the chat ended or `close()` was called. Get a fresh instance from `chat.liveChat()`. */
  get active(): boolean {
    return !this.#ended && !this.#closed
  }

  /** A handover is waiting or open: `send()` and `upload()` go to the team member. Otherwise use `chat.send()`. */
  get canSend(): boolean {
    return this.active && (this.#status === 'waiting' || this.#status === 'open')
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
   * unless `canSend` is true (see `chat.requestHuman()`).
   */
  async send(text: string): Promise<LiveChatMessage> {
    const content = text.trim()
    if (!content) throw new WebChatAgentError('Message is empty.', { code: 'INVALID_INPUT' })
    this.#assertCanSend()
    if (!this.#sendFrame({ type: 'client:message', sender: 'user', content })) {
      throw new WebChatAgentError('Not connected. Wait for the ready event and try again.', { code: 'NETWORK' })
    }
    this.typing(false)
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

  /** Tell the team member whether the visitor is typing. Call it on every keystroke; repeats are not sent. */
  typing(isTyping: boolean): void {
    if (isTyping === this.#typing) return
    if (this.#sendFrame({ type: 'client:typing', sender: 'user', isTyping })) this.#typing = isTyping
  }

  /** Send a file (max 5 MB) to the team member. It also arrives as a `message` event with `file`. */
  async upload(file: Blob, name?: string): Promise<UploadedFile> {
    this.#assertCanSend()
    return this.#ctx.upload(file, name)
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

  #assertCanSend(): void {
    if (!this.canSend) {
      throw new WebChatAgentError('No live chat is waiting or open. Call requestHuman() first.', { code: 'LIVE_CHAT_INACTIVE' })
    }
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
      this.#sendFrame({ type: 'client:join', as: 'user', lang: this.#ctx.language })
      this.#sendFrame({
        type: 'client:meta',
        pageUrl: currentPageUrl(),
        pageTitle: globalThis.document?.title,
        browserLanguage: browserLanguage(),
      })
    }
    socket.onmessage = (event: { data: unknown }) => {
      if (typeof event.data === 'string') this.#handle(event.data)
    }
    socket.onerror = () => undefined // a close event follows
    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#ready = false
      this.#typing = false
      if (!this.active) return
      this.#emit('disconnected', undefined)
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect(): void {
    clearTimeout(this.#reconnectTimer)
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#reconnectAttempts++)
    this.#reconnectTimer = setTimeout(() => {
      if (this.active) this.#connect()
    }, delay)
  }

  #sendFrame(frame: JsonObject): boolean {
    const socket = this.#socket
    if (!socket || socket.readyState !== OPEN) return false
    // The server silently drops frames without chatbotId and sessionId. `undefined` fields are dropped.
    socket.send(JSON.stringify({ ...frame, chatbotId: this.#ctx.chatbotId, sessionId: this.#ctx.sessionId }))
    return true
  }

  #handle(data: string): void {
    const frame = parseJson(data)
    if (!isObject(frame)) return
    switch (frame['type']) {
      case 'livechat:status':
        return this.#handleStatus(frame)
      case 'livechat:message': {
        if (frame['audience'] === 'admin') return // copies meant for the team member
        const message = toLiveChatMessage(frame, this.#ctx.baseUrl)
        if (message) this.#deliver(message)
        return
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
      this.#reconnectAttempts = 0
      this.#emit('ready', undefined)
      void this.#catchUp()
      return
    }
    const status = toLiveChatState(frame['status'])
    if (!status) return
    this.#status = status
    this.#emit('status', { status, mode: toChatMode(frame['mode']) })
    // While joining, a closed session is followed by `ended: already_closed`.
    // Once joined, the server may close a waiting chat with a status update only.
    if (status === 'closed' && this.#ready) this.#finish('closed')
  }

  /**
   * The server does not replay messages to visitors after a reconnect. The first join
   * records the stored IDs (the app loads `history()` itself); later joins deliver what is new.
   */
  async #catchUp(): Promise<void> {
    let rows: HistoryMessage[]
    try {
      rows = await this.#ctx.history()
    } catch {
      return // ponytail: best effort, the next reconnect tries again
    }
    if (!this.#seen) {
      this.#seen = new Set(rows.map((row) => row.id))
      return
    }
    for (const { sources, suggestions, role, ...row } of rows) {
      if (role !== 'assistant') this.#deliver({ ...row, role })
    }
  }

  #deliver(message: LiveChatMessage): void {
    if (message.id !== null) {
      if (this.#seen?.has(message.id)) return
      this.#seen?.add(message.id)
    }
    if (message.role === 'user') this.#resolveEcho(message)
    this.#emit('message', message)
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

function toLiveChatMessage(frame: JsonObject, baseUrl: string): LiveChatMessage | null {
  const sender = frame['sender']
  const role = sender === 'user' ? 'user' : sender === 'admin' ? 'agent' : sender === 'system' ? 'system' : null
  if (!role) return null
  const file = parseFile(frame['file'], baseUrl)
  return {
    id: typeof frame['id'] === 'number' ? frame['id'] : null,
    role,
    ...messageContent(role, asString(frame['content']), file),
    file,
    createdAt: toIsoDate(frame['createdAt']),
  }
}
