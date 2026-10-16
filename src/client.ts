import { WebChatAgentError } from './errors.js'
import { LiveChat } from './live-chat.js'
import {
  absoluteUrl,
  ACTION_BAR_TYPES,
  asString,
  browserLanguage,
  cleanStreamingText,
  currentPageUrl,
  errorInfo,
  extractSuggestions,
  FORM_FIELD_TYPES,
  isObject,
  isUuid,
  messageContent,
  parseFile,
  parseJson,
  parseSources,
  randomUuid,
  readSseFrames,
  toChatMode,
  toIsoDate,
  toLiveChatState,
  type JsonObject,
} from './parse.js'
import type {
  ActionBarItem,
  ChatbotConfig,
  ChatMode,
  ChatReply,
  ChatStreamEvent,
  FetchLike,
  Form,
  FormField,
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
/** Widget settings holding image URLs; uploaded images are stored relative to the API origin. */
const IMAGE_SETTINGS = ['avatarSrc', 'welcomeImage', 'chatBubbleImage'] as const

interface PostOptions {
  accept?: string
  headers?: Record<string, string>
  signal?: AbortSignal | undefined
}

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
    if (options.sessionId) this.#useSession(options.sessionId)
  }

  /**
   * ID of the current conversation (UUID). Treat it like a password: anyone who has it
   * can read the conversation.
   */
  get sessionId(): string {
    return (this.#sessionId ??= this.#loadSession())
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
      if (frame['type'] === 'token') {
        raw += asString(frame['data'])
        const text = cleanStreamingText(raw)
        if (text === shown) continue
        const delta = text.startsWith(shown) ? text.slice(shown.length) : ''
        shown = text
        yield { type: 'text', text, delta }
      } else if (frame['type'] === 'error') {
        lastError = asString(frame['data'], 'Unknown error')
        yield { type: 'error', message: lastError }
      } else if (frame['type'] === 'done') {
        yield { type: 'done', reply: this.#toReply(frame, message) }
        return
      }
    }
    throw new WebChatAgentError(lastError ?? 'The answer stream ended before it was complete.', {
      code: 'STREAM_INTERRUPTED',
      status: response.status,
    })
  }

  /** Messages of the current conversation, oldest first. Empty for new or expired (30 days) conversations. */
  async history(): Promise<HistoryMessage[]> {
    let body: JsonObject
    try {
      body = await this.#getJson(`/api/chat/history?${this.#query()}`)
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
    const widget = toWidgetSettings(body['widgetProperties'], this.baseUrl)
    const inlineWidget = toWidgetSettings(body['embeddedWidgetProperties'], this.baseUrl)
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
        url: absoluteUrl(asString(body['poweredByUrl']), this.baseUrl) || DEFAULT_BASE_URL,
      },
    }
  }

  /**
   * Upload a file (max 2 MB; images, PDF, TXT, CSV, DOCX, XLS, XLSX) for the bot to read.
   * Then send it with `send(text, { attachment })`. Requires `config.features.fileUpload`.
   * Pass `name` for a plain `Blob`: the server checks the file extension.
   *
   * @example
   * const attachment = await chat.upload(input.files[0])
   * const reply = await chat.send('What does this invoice say?', { attachment })
   */
  async upload(file: Blob, name?: string): Promise<UploadedFile> {
    return this.#uploadTo('/api/ai-chat/upload', file, name, false)
  }

  /**
   * Rate an answer. Rating the same message again replaces the rating.
   * Requires `config.features.feedback`.
   */
  async feedback(message: ChatReply | HistoryMessage, rating: 'up' | 'down'): Promise<void> {
    await this.#postJson('/api/feedback/thumb', {
      ...this.#ids(),
      messageId: String(message.id),
      rating,
      answer: message.text.slice(0, 10000),
      question: 'question' in message ? message.question.slice(0, 2000) : undefined,
      language: this.#visitorLanguage()?.slice(0, 10),
      pageUrl: currentPageUrl()?.slice(0, 2048),
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
    await this.#postJson('/api/leads/form-submit', { ...this.#ids(), formId: form.id, formName: form.name, data })
  }

  /**
   * Ask for a human team member. On success open `liveChat()` to talk to them.
   * The bot can also hand over by itself, then a reply has `mode: 'human'`.
   */
  async requestHuman(options: RequestHumanOptions = {}): Promise<RequestHumanResult> {
    const body = await this.#postJson(
      '/api/livechats/request',
      {
        chatbotId: this.chatbotId,
        name: options.name || undefined,
        email: options.email || undefined,
        reason: options.reason || undefined,
        userLanguage: this.#visitorLanguage(),
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
    const body = await this.#getJson(`/api/livechats/status?${this.#query()}`)
    const status = toLiveChatState(body['status'])
    return body['exists'] === true && status ? { status, mode: toChatMode(body['mode']) } : null
  }

  /**
   * Connect to the live chat of the current conversation. Returns the existing
   * connection while it is active. Reconnects automatically and delivers messages
   * missed while disconnected.
   */
  liveChat(): LiveChat {
    if (this.#liveChat?.active) return this.#liveChat
    const WebSocketImpl = this.#WebSocket ?? (globalThis.WebSocket as WebSocketConstructorLike | undefined)
    if (!WebSocketImpl) {
      throw new WebChatAgentError('No WebSocket available. Pass the WebSocket option.', { code: 'INVALID_INPUT' })
    }
    const url = new URL('/api/livechat', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ids = this.#ids()
    this.#liveChat = new LiveChat({
      ...ids,
      url: url.href,
      baseUrl: this.baseUrl,
      language: this.#visitorLanguage(),
      WebSocket: WebSocketImpl,
      history: () => this.history(),
      end: async () => {
        await this.#postJson('/api/livechats/end', ids)
      },
      upload: (file, name) => this.#uploadTo('/api/livechat/upload', file, name, true),
    })
    return this.#liveChat
  }

  /** Start a new conversation. Disconnects an open live chat without ending it. */
  reset(): void {
    this.#liveChat?.close()
    this.#liveChat = null
    this.#useSession(randomUuid())
  }

  // --- internals ---

  #ids(): { chatbotId: string; sessionId: string } {
    return { chatbotId: this.chatbotId, sessionId: this.sessionId }
  }

  #query(): string {
    return new URLSearchParams(this.#ids()).toString()
  }

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
    return isUuid(stored) ? stored : this.#useSession(randomUuid())
  }

  #useSession(id: string): string {
    this.#sessionId = id
    try {
      this.#storage?.setItem(this.#storageKey, id)
    } catch {
      // see #loadSession
    }
    return id
  }

  #visitorLanguage(): string | undefined {
    return this.#language ?? browserLanguage()
  }

  async #postChat(message: string, options: SendOptions, stream: boolean): Promise<Response> {
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new WebChatAgentError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters.`, { code: 'INVALID_INPUT' })
    }
    if (!message.trim() && !options.attachment) {
      throw new WebChatAgentError('Message is empty.', { code: 'INVALID_INPUT' })
    }
    const { attachment } = options
    const response = await this.#post(
      '/api/chat',
      {
        message,
        chatbotId: this.chatbotId,
        pageUrl: options.pageUrl ?? currentPageUrl(),
        contextData: options.contextData,
        attachment: attachment && { uploadId: attachment.uploadId, messageId: attachment.messageId },
      },
      {
        accept: stream ? 'text/event-stream' : 'application/json',
        headers: { 'X-Chat-Session-Id': this.sessionId },
        signal: options.signal,
      },
    )
    const serverSession = response.headers.get('x-chat-session-id')
    if (isUuid(serverSession) && serverSession !== this.#sessionId) this.#useSession(serverSession)
    return response
  }

  #toReply(body: JsonObject, question: string): ChatReply {
    const aiGenerated = body['aiGenerated'] === true
    // While a team member handles the chat the server answers without `aiGenerated`.
    const human = body['mode'] === 'human' || !aiGenerated
    const { text, suggestions } = extractSuggestions(asString(body['reply']))
    return {
      id: randomUuid(),
      question,
      text,
      sources: parseSources(body['sources'], this.baseUrl),
      suggestions,
      mode: human ? 'human' : 'bot',
      status: human ? (toLiveChatState(body['status']) ?? (body['_liveChatOpen'] === true ? 'open' : 'waiting')) : null,
      aiGenerated,
      conversationTooLong: body['conversationTooLong'] === true,
      attachmentTruncated: body['attachmentTruncated'] === true,
    }
  }

  #toHistoryMessage(row: JsonObject): HistoryMessage {
    const role: MessageRole =
      row['role'] === 'user' ? 'user' : row['role'] === 'system' ? 'system' : row['isAgent'] === true ? 'agent' : 'assistant'
    const sources = parseSources(row['sources'], this.baseUrl)
    const file = sources.find((source) => source.type === 'file')?.data ?? null
    const raw = asString(row['text'])
    const content = messageContent(role, raw, file)
    const { text, suggestions } = role === 'assistant' ? extractSuggestions(raw) : { text: content.text, suggestions: [] }
    return {
      id: typeof row['id'] === 'number' ? row['id'] : Number(row['id']),
      role,
      text,
      file,
      sources,
      suggestions,
      event: content.event,
      createdAt: toIsoDate(row['createdAt']),
    }
  }

  async #uploadTo(path: string, file: Blob, name: string | undefined, asUser: boolean): Promise<UploadedFile> {
    const form = new FormData()
    form.append('file', file, name ?? fileName(file))
    form.append('chatbotId', this.chatbotId)
    form.append('sessionId', this.sessionId)
    const language = this.#visitorLanguage()
    if (language) form.append('lang', language)
    if (asUser) form.append('as', 'user')
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

  /** POST a JSON body. `undefined` fields are dropped by `JSON.stringify`. */
  async #post(path: string, body: JsonObject, options: PostOptions = {}): Promise<Response> {
    return this.#request(path, {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json', Accept: options.accept ?? 'application/json', ...options.headers }),
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    })
  }

  async #postJson(path: string, body: JsonObject, headers: Record<string, string> = {}): Promise<JsonObject> {
    return readJson(await this.#post(path, body, { headers }))
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
  const body = parseJson(await response.text().catch(() => ''))
  return isObject(body) ? body : {}
}

async function toHttpError(response: Response): Promise<WebChatAgentError> {
  const text = await response.text().catch(() => '')
  const body = parseJson(text) ?? text
  const { code, message } = errorInfo(body, response.status)
  return new WebChatAgentError(message, { code, status: response.status, body })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === '' || value === false
}

function fileName(file: Blob): string {
  return 'name' in file && typeof file.name === 'string' && file.name ? file.name : 'upload'
}

function toWidgetSettings(value: unknown, baseUrl: string): WidgetSettings {
  if (!isObject(value)) return {}
  // ponytail: dashboard-written JSON is trusted; only fields the SDK computes with or that hold URLs are normalized.
  const settings: WidgetSettings = { ...value }
  for (const key of IMAGE_SETTINGS) {
    if (typeof value[key] === 'string') settings[key] = absoluteUrl(value[key], baseUrl)
  }
  if ('promptButtons' in value) settings.promptButtons = toPromptButtons(value['promptButtons'])
  if ('forms' in value) settings.forms = Array.isArray(value['forms']) ? value['forms'].flatMap(toForm) : []
  const bar = value['actionBar']
  if (isObject(bar) && Array.isArray(bar['items'])) {
    settings.actionBar = {
      enabled: bar['enabled'] === true,
      items: bar['items'].filter(isObject).flatMap((item) => toActionBarItem(item, baseUrl)),
    }
  }
  return settings
}

function toActionBarItem(item: JsonObject, baseUrl: string): ActionBarItem[] {
  const type = ACTION_BAR_TYPES.find((t) => t === item['type'])
  if (typeof item['id'] !== 'string' || !type) return []
  const result: ActionBarItem = { id: item['id'], type, label: asString(item['label']) }
  for (const key of ['icon', 'phoneNumber', 'formId'] as const) {
    const value = item[key]
    if (typeof value === 'string') result[key] = value
  }
  for (const key of ['iconOnly', 'openInNewTab'] as const) {
    const value = item[key]
    if (typeof value === 'boolean') result[key] = value
  }
  if (typeof item['url'] === 'string') result.url = absoluteUrl(item['url'], baseUrl)
  return [result]
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
  const type = FORM_FIELD_TYPES.find((t) => t === value['type']) ?? 'text'
  const field: FormField = { id: value['id'], type, label: asString(value['label']), required: value['required'] === true }
  if (typeof value['placeholder'] === 'string') field.placeholder = value['placeholder']
  if (Array.isArray(value['options'])) field.options = value['options'].filter((o): o is string => typeof o === 'string')
  return [field]
}

/** Forms the server accepts: listed by an item of the enabled Action Bar. */
function activeForms(widget: WidgetSettings): Form[] {
  const bar = widget.actionBar
  if (!bar?.enabled) return []
  const formIds = new Set(bar.items.flatMap((item) => (item.type === 'form' && item.formId ? [item.formId] : [])))
  return (widget.forms ?? []).filter((form) => formIds.has(form.id) && form.name.trim() !== '')
}
