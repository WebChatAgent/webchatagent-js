import { WebChatAgentError } from './errors.js'
import { LiveChat } from './live-chat.js'
import {
  asString,
  cleanStreamingText,
  errorMessage,
  extractSuggestions,
  isObject,
  isUuid,
  parseFile,
  parseSources,
  randomUuid,
  readSseFrames,
  systemEvent,
  toIsoDate,
  type JsonObject,
} from './parse.js'
import type {
  ChatbotConfig,
  ChatMode,
  ChatReply,
  ChatStreamEvent,
  FetchLike,
  Form,
  FormField,
  FormFieldType,
  FormValues,
  HistoryMessage,
  LiveChatState,
  MessageRole,
  PromptButton,
  RequestHumanOptions,
  RequestHumanResult,
  SendOptions,
  StorageLike,
  UploadedFile,
  WebChatAgentOptions,
  WebSocketConstructorLike,
  WidgetSettings,
} from './types.js'

/** Longest message the server accepts. */
export const MAX_MESSAGE_LENGTH = 700

const DEFAULT_BASE_URL = 'https://webchatagent.com'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FIELD_TYPES: readonly FormFieldType[] = ['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'number', 'info']

/**
 * Client for one chatbot and one conversation (session).
 *
 * @example
 * import { WebChatAgent } from 'webchatagent'
 *
 * const chat = new WebChatAgent({ chatbotId: 'YOUR-CHATBOT-ID', storage: localStorage })
 * const reply = await chat.send('What are your opening hours?')
 * console.log(reply.text)
 */
export class WebChatAgent {
  readonly chatbotId: string
  /** API origin, e.g. `https://webchatagent.com`. */
  readonly baseUrl: string
  readonly #fetch: FetchLike
  readonly #storage: StorageLike | undefined
  readonly #language: string | undefined
  readonly #WebSocket: WebSocketConstructorLike | undefined
  #sessionId: string | undefined
  #liveChat: LiveChat | null = null

  constructor(options: WebChatAgentOptions) {
    if (!isUuid(options.chatbotId)) {
      throw new WebChatAgentError('chatbotId must be the UUID shown in your dashboard.', { code: 'INVALID_INPUT' })
    }
    if (options.sessionId !== undefined && !isUuid(options.sessionId)) {
      throw new WebChatAgentError('sessionId must be a UUID.', { code: 'INVALID_INPUT' })
    }
    this.chatbotId = options.chatbotId
    this.baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#storage = options.storage
    this.#language = options.language
    this.#WebSocket = options.WebSocket
    this.#sessionId = options.sessionId
    if (this.#sessionId) this.#saveSession(this.#sessionId)
  }

  /**
   * ID of the current conversation (UUID). Treat it like a password: anyone who has it
   * can read the conversation.
   */
  get sessionId(): string {
    this.#sessionId ??= this.#loadSession()
    return this.#sessionId
  }

  /**
   * Send a message and wait for the complete answer.
   *
   * @example
   * const reply = await chat.send('Do you ship to Austria?')
   * render(reply.text)          // Markdown
   * reply.suggestions           // follow-up buttons
   * if (reply.mode === 'human') chat.liveChat() // a team member took over
   */
  async send(message: string, options: SendOptions = {}): Promise<ChatReply> {
    const response = await this.#postChat(message, options, false)
    return this.#toReply(await readJson(response), message)
  }

  /**
   * Send a message and receive the answer while it is being written.
   * Breaking out of the loop or aborting `options.signal` stops the answer on the server.
   *
   * @example
   * for await (const event of chat.stream('Which plan fits a small shop?')) {
   *   if (event.type === 'text') render(event.text)
   *   if (event.type === 'done') renderFinal(event.reply)
   * }
   */
  async *stream(message: string, options: SendOptions = {}): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const response = await this.#postChat(message, options, true)
    const isEventStream = response.headers.get('content-type')?.includes('text/event-stream') === true
    if (!isEventStream || !response.body) {
      // Streaming is off for this bot, or a team member handles the chat: the server answers with JSON.
      yield { type: 'done', reply: this.#toReply(await readJson(response), message) }
      return
    }
    let raw = ''
    let shown = ''
    let lastError: string | null = null
    for await (const frame of readSseFrames(response.body)) {
      switch (frame['type']) {
        case 'token': {
          raw += asString(frame['data'])
          const text = cleanStreamingText(raw)
          if (text === shown) break
          const delta = text.startsWith(shown) ? text.slice(shown.length) : ''
          shown = text
          yield { type: 'text', text, delta }
          break
        }
        case 'tool_call':
          yield { type: 'tool', name: asString(frame['name']) }
          break
        case 'error':
          lastError = asString(frame['data'], 'Unknown error')
          yield { type: 'error', message: lastError }
          break
        case 'done':
          yield { type: 'done', reply: this.#toReply(frame, message) }
          return
        default:
          break
      }
    }
    throw new WebChatAgentError(lastError ?? 'The answer stream ended before it was complete.', {
      code: 'STREAM_INTERRUPTED',
      status: response.status,
    })
  }

  /** Messages of the current conversation, oldest first. Empty for new or expired (30 days) conversations. */
  async history(): Promise<HistoryMessage[]> {
    const query = new URLSearchParams({ chatbotId: this.chatbotId, sessionId: this.sessionId })
    let body: JsonObject
    try {
      body = await this.#getJson(`/api/chat/history?${query.toString()}`)
    } catch (error) {
      if (error instanceof WebChatAgentError && error.status === 410) return []
      throw error
    }
    const messages = Array.isArray(body['messages']) ? body['messages'] : []
    return messages.filter(isObject).map((row) => this.#toHistoryMessage(row))
  }

  /**
   * Settings, enabled features and lead forms of the chatbot.
   *
   * @example
   * const config = await chat.getConfig()
   * showWelcome(config.widget.welcomeMessage)
   * if (config.branding.required) showPoweredBy(config.branding.text, config.branding.url)
   */
  async getConfig(): Promise<ChatbotConfig> {
    const body = await this.#getJson(`/api/chatbots/${encodeURIComponent(this.chatbotId)}/public`)
    const widget = toWidgetSettings(body['widgetProperties'])
    const inlineWidget = toWidgetSettings(body['embeddedWidgetProperties'])
    return {
      archived: body['archived'] === true,
      widget,
      inlineWidget,
      features: {
        fileUpload: widget.fileUploadEnabled === true || inlineWidget.fileUploadEnabled === true,
        feedback: body['toolFeedbackActive'] === true && widget.thumbsFeedbackEnabled !== false,
        liveChat: body['liveChatActive'] === true,
        askName: widget.liveChatAskName === true,
        askEmail: widget.liveChatAskEmail === true,
      },
      forms: activeForms(widget),
      liveChatTimeoutMinutes: typeof body['liveChatTimeoutMinutes'] === 'number' ? body['liveChatTimeoutMinutes'] : 5,
      branding: {
        required: body['canHideBranding'] !== true,
        text: asString(body['poweredByText'], 'Powered by WebChatAgent'),
        url: asString(body['poweredByUrl'], DEFAULT_BASE_URL),
      },
    }
  }

  /**
   * Upload a file (max 2 MB; images, PDF, TXT, CSV, DOCX, XLS, XLSX) for the bot to read.
   * Then send it with `send(text, { attachment })`. Requires `config.features.fileUpload`.
   *
   * @example
   * const attachment = await chat.upload(input.files[0])
   * const reply = await chat.send('What does this invoice say?', { attachment })
   */
  async upload(file: Blob, name?: string): Promise<UploadedFile> {
    return this.#uploadTo('/api/ai-chat/upload', file, name, {})
  }

  /**
   * Rate an answer. Rating the same message again replaces the rating.
   * Requires `config.features.feedback`.
   */
  async feedback(message: ChatReply | HistoryMessage, rating: 'up' | 'down'): Promise<void> {
    const pageUrl = currentPageUrl()
    const language = this.#visitorLanguage()
    await this.#postJson('/api/feedback/thumb', {
      chatbotId: this.chatbotId,
      sessionId: this.sessionId,
      messageId: String(message.id),
      rating,
      answer: message.text.slice(0, 10000),
      ...('question' in message ? { question: message.question.slice(0, 2000) } : {}),
      ...(language ? { language: language.slice(0, 10) } : {}),
      ...(pageUrl ? { pageUrl: pageUrl.slice(0, 2048) } : {}),
    })
  }

  /**
   * Submit a lead form from `config.forms`. `values` are keyed by field ID.
   * Throws `INVALID_INPUT` with `body: { missing, invalid }` (field IDs) before sending.
   *
   * @example
   * const [form] = (await chat.getConfig()).forms
   * await chat.submitForm(form, { [form.fields[0].id]: 'Jane Doe' })
   */
  async submitForm(form: Form, values: FormValues): Promise<void> {
    const fields = form.fields.filter((field) => field.type !== 'info')
    const missing = fields.filter((field) => field.required && isEmptyValue(values[field.id])).map((field) => field.id)
    const invalid = fields
      .filter((field) => {
        const value = values[field.id]
        return field.type === 'email' && typeof value === 'string' && value !== '' && !EMAIL_RE.test(value)
      })
      .map((field) => field.id)
    if (missing.length > 0 || invalid.length > 0) {
      throw new WebChatAgentError('Please fill in all required fields with valid values.', {
        code: 'INVALID_INPUT',
        body: { missing, invalid },
      })
    }
    // The server stores values under the (translated) field label, like the official widget.
    const data = Object.fromEntries(
      fields.flatMap((field) => {
        const value = values[field.id]
        return isEmptyValue(value) ? [] : [[field.label, value]]
      }),
    )
    await this.#postJson('/api/leads/form-submit', {
      chatbotId: this.chatbotId,
      sessionId: this.sessionId,
      formId: form.id,
      formName: form.name,
      data,
    })
  }

  /**
   * Ask for a human team member. On success open `liveChat()` to talk to them.
   * The bot can also hand over by itself, then a reply has `mode: 'human'`.
   */
  async requestHuman(options: RequestHumanOptions = {}): Promise<RequestHumanResult> {
    const language = this.#visitorLanguage()
    const body = await this.#postJson(
      '/api/livechats/request',
      {
        chatbotId: this.chatbotId,
        ...(options.name ? { name: options.name } : {}),
        ...(options.email ? { email: options.email } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(language ? { userLanguage: language } : {}),
      },
      { 'X-Chat-Session-Id': this.sessionId },
    )
    if (body['ok'] === true) return { ok: true }
    return { ok: false, reason: body['reason'] === 'plan_not_supported' ? 'plan_not_supported' : 'tool_inactive' }
  }

  /**
   * Live chat state of the current conversation, `null` if there never was one.
   * Use it after a page reload to resume: if `status` is `waiting` or `open`, call `liveChat()`.
   */
  async liveChatStatus(): Promise<{ status: LiveChatState; mode: ChatMode } | null> {
    const query = new URLSearchParams({ chatbotId: this.chatbotId, sessionId: this.sessionId })
    const body = await this.#getJson(`/api/livechats/status?${query.toString()}`)
    const status = body['status']
    if (body['exists'] !== true || (status !== 'waiting' && status !== 'open' && status !== 'closed')) return null
    return { status, mode: body['mode'] === 'human' ? 'human' : 'bot' }
  }

  /**
   * Connect to the live chat of the current conversation. Returns the existing
   * connection while it is active. Reconnects automatically.
   */
  liveChat(): LiveChat {
    if (this.#liveChat?.active) return this.#liveChat
    const WebSocketImpl = this.#WebSocket ?? (globalThis.WebSocket as WebSocketConstructorLike | undefined)
    if (!WebSocketImpl) {
      throw new WebChatAgentError('No WebSocket available. Pass the WebSocket option.', { code: 'INVALID_INPUT' })
    }
    const url = new URL('/api/livechat', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const sessionId = this.sessionId
    this.#liveChat = new LiveChat({
      url: url.href,
      baseUrl: this.baseUrl,
      chatbotId: this.chatbotId,
      sessionId,
      language: this.#visitorLanguage(),
      WebSocket: WebSocketImpl,
      end: async () => {
        await this.#postJson('/api/livechats/end', { chatbotId: this.chatbotId, sessionId })
      },
      upload: (file, name) => this.#uploadTo('/api/livechat/upload', file, name, { as: 'user' }),
    })
    return this.#liveChat
  }

  /** Start a new conversation. Disconnects an open live chat without ending it. */
  reset(): void {
    this.#liveChat?.close()
    this.#liveChat = null
    this.#sessionId = randomUuid()
    this.#saveSession(this.#sessionId)
  }

  // --- internals ---

  get #storageKey(): string {
    return `webchatagent:session:${this.chatbotId}`
  }

  #loadSession(): string {
    let stored: string | null = null
    try {
      stored = this.#storage?.getItem(this.#storageKey) ?? null
    } catch {
      // Storage blocked (private mode, sandboxed iframe): keep the session in memory.
    }
    if (isUuid(stored)) return stored
    const id = randomUuid()
    this.#saveSession(id)
    return id
  }

  #saveSession(id: string): void {
    try {
      this.#storage?.setItem(this.#storageKey, id)
    } catch {
      // see #loadSession
    }
  }

  #visitorLanguage(): string | undefined {
    return this.#language ?? (typeof navigator === 'undefined' ? undefined : navigator.language || undefined)
  }

  async #postChat(message: string, options: SendOptions, stream: boolean): Promise<Response> {
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new WebChatAgentError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters.`, { code: 'INVALID_INPUT' })
    }
    if (!message.trim() && !options.attachment) {
      throw new WebChatAgentError('Message is empty.', { code: 'INVALID_INPUT' })
    }
    const pageUrl = options.pageUrl ?? currentPageUrl()
    const response = await this.#request('/api/chat', {
      method: 'POST',
      headers: this.#headers({
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        'X-Chat-Session-Id': this.sessionId,
      }),
      body: JSON.stringify({
        message,
        chatbotId: this.chatbotId,
        ...(pageUrl ? { pageUrl } : {}),
        ...(options.contextData ? { contextData: options.contextData } : {}),
        ...(options.attachment
          ? { attachment: { uploadId: options.attachment.uploadId, messageId: options.attachment.messageId } }
          : {}),
      }),
      signal: options.signal ?? null,
    })
    const serverSession = response.headers.get('x-chat-session-id')
    if (isUuid(serverSession) && serverSession !== this.#sessionId) {
      this.#sessionId = serverSession
      this.#saveSession(serverSession)
    }
    return response
  }

  #toReply(body: JsonObject, question: string): ChatReply {
    const aiGenerated = body['aiGenerated'] === true
    // While a team member handles the chat the server answers without `aiGenerated`.
    const human = body['mode'] === 'human' || !aiGenerated
    const status = body['status']
    const { text, suggestions } = extractSuggestions(asString(body['reply']))
    return {
      id: randomUuid(),
      question,
      text,
      sources: parseSources(body['sources'], this.baseUrl),
      suggestions,
      mode: human ? 'human' : 'bot',
      status: !human
        ? null
        : status === 'waiting' || status === 'open' || status === 'closed'
          ? status
          : body['_liveChatOpen'] === true
            ? 'open'
            : 'waiting',
      aiGenerated,
      conversationTooLong: body['conversationTooLong'] === true,
      attachmentTruncated: body['attachmentTruncated'] === true,
    }
  }

  #toHistoryMessage(row: JsonObject): HistoryMessage {
    const role: MessageRole =
      row['role'] === 'user' ? 'user' : row['role'] === 'system' ? 'system' : row['isAgent'] === true ? 'agent' : 'assistant'
    const raw = asString(row['text'])
    const event = role === 'system' ? systemEvent(raw) : null
    const { text, suggestions } = role === 'assistant' ? extractSuggestions(raw) : { text: event ? '' : raw, suggestions: [] }
    return {
      id: typeof row['id'] === 'number' ? row['id'] : Number(row['id']),
      role,
      text,
      sources: parseSources(row['sources'], this.baseUrl),
      suggestions,
      event,
      createdAt: toIsoDate(row['createdAt']),
    }
  }

  async #uploadTo(path: string, file: Blob, name: string | undefined, extra: Record<string, string>): Promise<UploadedFile> {
    const form = new FormData()
    form.append('file', file, name ?? fileName(file))
    form.append('chatbotId', this.chatbotId)
    form.append('sessionId', this.sessionId)
    const language = this.#visitorLanguage()
    if (language) form.append('lang', language)
    for (const [key, value] of Object.entries(extra)) form.append(key, value)
    const response = await this.#request(path, { method: 'POST', headers: this.#headers({}), body: form })
    const body = await readJson(response)
    const uploaded = parseFile(body['file'], this.baseUrl)
    const messageId = body['messageId']
    if (!uploaded || typeof messageId !== 'number') {
      throw new WebChatAgentError('Unexpected upload response.', { code: 'HTTP', status: response.status, body })
    }
    return { ...uploaded, messageId }
  }

  #headers(extra: Record<string, string>): Record<string, string> {
    return { ...(this.#language ? { 'Accept-Language': this.#language } : {}), ...extra }
  }

  async #getJson(path: string): Promise<JsonObject> {
    return readJson(await this.#request(path, { method: 'GET', headers: this.#headers({ Accept: 'application/json' }) }))
  }

  async #postJson(path: string, body: JsonObject, headers: Record<string, string> = {}): Promise<JsonObject> {
    const response = await this.#request(path, {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json', Accept: 'application/json', ...headers }),
      body: JSON.stringify(body),
    })
    return readJson(response)
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await this.#fetch(new URL(path, this.baseUrl).href, init)
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new WebChatAgentError(`Could not reach ${this.baseUrl}. Check the connection and the baseUrl option.`, {
        code: 'NETWORK',
        cause: error,
      })
    }
    if (!response.ok) throw await toHttpError(response)
    return response
  }
}

function parseBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebChatAgentError(`baseUrl "${value}" is not a valid URL.`, { code: 'INVALID_INPUT' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebChatAgentError('baseUrl must start with https:// or http://.', { code: 'INVALID_INPUT' })
  }
  return url.origin
}

async function readJson(response: Response): Promise<JsonObject> {
  const body: unknown = await response.json().catch(() => null)
  return isObject(body) ? body : {}
}

async function toHttpError(response: Response): Promise<WebChatAgentError> {
  const text = await response.text().catch(() => '')
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON, keep the text
  }
  const serverCode = isObject(body) ? body['code'] : undefined
  return new WebChatAgentError(errorMessage(body, response.status), {
    code: serverCode === 'FILE_TOO_LARGE' || serverCode === 'UNSUPPORTED_TYPE' ? serverCode : 'HTTP',
    status: response.status,
    body,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === '' || value === false
}

function currentPageUrl(): string | undefined {
  return typeof location === 'undefined' ? undefined : location.href
}

function fileName(file: Blob): string {
  return 'name' in file && typeof file.name === 'string' && file.name ? file.name : 'upload'
}

function toWidgetSettings(value: unknown): WidgetSettings {
  if (!isObject(value)) return {}
  // ponytail: dashboard-written JSON is trusted; only the fields the SDK computes with are normalized.
  const settings: WidgetSettings = { ...value }
  if ('promptButtons' in value) settings.promptButtons = toPromptButtons(value['promptButtons'])
  if ('forms' in value) settings.forms = Array.isArray(value['forms']) ? value['forms'].flatMap(toForm) : []
  return settings
}

function toPromptButtons(value: unknown): PromptButton[] {
  return (Array.isArray(value) ? value : [])
    .filter(isObject)
    .map((button) => ({ title: asString(button['title']), action: asString(button['action']) }))
    .filter((button) => button.title && button.action)
}

function toForm(value: unknown): Form[] {
  if (!isObject(value) || typeof value['id'] !== 'string' || typeof value['name'] !== 'string') return []
  const form: Form = {
    id: value['id'],
    name: value['name'],
    fields: (Array.isArray(value['fields']) ? value['fields'] : []).flatMap(toFormField),
  }
  if (typeof value['submitLabel'] === 'string') form.submitLabel = value['submitLabel']
  if (typeof value['successMessage'] === 'string') form.successMessage = value['successMessage']
  return [form]
}

function toFormField(value: unknown): FormField[] {
  if (!isObject(value) || typeof value['id'] !== 'string') return []
  const type = FIELD_TYPES.find((t) => t === value['type']) ?? 'text'
  const field: FormField = { id: value['id'], type, label: asString(value['label']), required: value['required'] === true }
  if (typeof value['placeholder'] === 'string') field.placeholder = value['placeholder']
  if (Array.isArray(value['options'])) field.options = value['options'].filter((o): o is string => typeof o === 'string')
  return [field]
}

/** Forms the server accepts: listed by an item of the enabled Action Bar. */
function activeForms(widget: WidgetSettings): Form[] {
  const bar = widget['actionBar']
  if (!isObject(bar) || bar['enabled'] !== true || !Array.isArray(bar['items'])) return []
  const formIds = new Set(
    bar['items'].filter(isObject).flatMap((item) => (item['type'] === 'form' && typeof item['formId'] === 'string' ? [item['formId']] : [])),
  )
  return (widget.forms ?? []).filter((form) => formIds.has(form.id) && form.name.trim() !== '')
}
