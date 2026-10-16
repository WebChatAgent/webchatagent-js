/** Minimal synchronous key/value store, e.g. `window.localStorage` or `sessionStorage`. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The subset of `fetch` the client uses. Pass your own for tests, proxies or older runtimes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The subset of a browser `WebSocket` the live chat uses. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: never) => void) | null
  onmessage: ((event: never) => void) | null
  onclose: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
}

/** A `WebSocket` constructor, e.g. `globalThis.WebSocket` or the `ws` package. */
export type WebSocketConstructorLike = new (url: string) => WebSocketLike

export interface WebChatAgentOptions {
  /** Chatbot ID (UUID). Dashboard → your chatbot → Integration. */
  chatbotId: string
  /**
   * API origin. Default `https://webchatagent.com`.
   * White-label partners use their own domain, e.g. `https://chat.example.com`.
   */
  baseUrl?: string | undefined
  /**
   * Continue an existing conversation. Must be a UUID.
   * Default: the ID saved in `storage`, otherwise a new random UUID.
   */
  sessionId?: string | undefined
  /**
   * Where to remember the session ID across page loads, e.g. `localStorage`.
   * Key: `webchatagent:session:<chatbotId>`. Read lazily on first use, errors are ignored.
   */
  storage?: StorageLike | undefined
  /** Visitor language (BCP 47, e.g. `de` or `en-US`). Sent as `Accept-Language` and used for live chat translation. */
  language?: string | undefined
  /** Custom `fetch`. Default: `globalThis.fetch`. */
  fetch?: FetchLike | undefined
  /** Custom WebSocket constructor for live chat. Default: `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructorLike | undefined
}

/** Free-form data about the visitor that the bot may use, e.g. `{ plan: 'pro', userId: 42 }`. Max 20 keys. */
export type ContextData = Record<string, string | number | boolean>

export interface SendOptions {
  /** URL of the page the visitor is on. Default in browsers: `location.href`. Helps the bot answer page-specific questions. */
  pageUrl?: string | undefined
  /** Extra facts about the visitor for this message. */
  contextData?: ContextData | undefined
  /** A file returned by `upload()`. With an attachment the message may be empty. */
  attachment?: UploadedFile | undefined
  /** Cancel the request. For `stream()` this also stops the answer on the server. */
  signal?: AbortSignal | undefined
}

/** A follow-up question the bot suggests. Show `label` on a button and send `text` when clicked. */
export interface Suggestion {
  label: string
  text: string
}

/** A file attached to a chat message. */
export interface ChatFile {
  uploadId: string
  name: string
  mimeType: string
  /** Size in bytes. */
  size: number
  /** Absolute download URL. */
  url: string
  isImage: boolean
}

/** Result of `upload()`. Pass it as `attachment` to `send()` or `stream()`. */
export interface UploadedFile extends ChatFile {
  /** Server-side message ID of the stored upload. */
  messageId: number
}

/** Where an answer came from. */
export type Source =
  /** A web page. `source` is its URL. */
  | { type: 'web'; source: string }
  /** A product from a product feed. `source` is the product ID. */
  | { type: 'product'; source: string; data?: ProductSourceData | undefined }
  /** A document from a connected file storage. `source` is its remote ID. */
  | { type: 'fileSource'; source: string; data?: FileSourceData | undefined }
  /** A file the visitor uploaded. `source` is its absolute URL. */
  | { type: 'file'; source: string; data: ChatFile }

export interface ProductSourceData {
  id: string
  dataType: string
  format: string
  /** The raw product record from the feed. */
  data: unknown
  sourceUrl: string
}

export interface FileSourceData {
  name: string
  path?: string | undefined
  /** e.g. `sharepoint`, `gdrive`, `webdav`, `sftp`. */
  provider?: string | undefined
  webUrl?: string | undefined
}

/** Who answers: the AI (`bot`) or a human team member (`human`). */
export type ChatMode = 'bot' | 'human'

/** `waiting` = handover requested, nobody joined yet. `open` = a team member is chatting. `closed` = ended. */
export type LiveChatState = 'waiting' | 'open' | 'closed'

/** A complete answer from `send()` or the final `done` event of `stream()`. */
export interface ChatReply {
  /** Client-generated ID. Pass the reply to `feedback()`. */
  id: string
  /** The message this reply answers. */
  question: string
  /** The answer as Markdown. Empty while a team member handles the chat. */
  text: string
  sources: Source[]
  suggestions: Suggestion[]
  /** `human`: a team member took over. Open `liveChat()` to receive their messages. */
  mode: ChatMode
  /** Live chat state while `mode` is `human`, otherwise `null`. */
  status: LiveChatState | null
  /** `true` when the text was written by the AI. Label such answers as AI-generated. */
  aiGenerated: boolean
  /** The conversation hit its length limit. Call `reset()` to start a new one. */
  conversationTooLong: boolean
  /** The attached file was too long and only its beginning was read. */
  attachmentTruncated: boolean
}

/** Events yielded by `stream()`. The last one is always `done`. */
export type ChatStreamEvent =
  /** New text. `text` is the full answer so far, cleaned for display. `delta` is what was added (may be empty). */
  | { type: 'text'; text: string; delta: string }
  /** The bot is using a tool, e.g. searching products or booking an appointment. */
  | { type: 'tool'; name: string }
  /** A problem the server recovered from. The stream continues. */
  | { type: 'error'; message: string }
  /** The final answer. */
  | { type: 'done'; reply: ChatReply }

/** Marker for system messages in history and live chat. */
export type SystemEvent = 'agent_joined' | 'ended' | 'timeout'

/** `user` = visitor, `assistant` = AI, `agent` = human team member, `system` = see `event`. */
export type MessageRole = 'user' | 'assistant' | 'agent' | 'system'

/** A stored message from `history()`. */
export interface HistoryMessage {
  /** Server ID. Stable, use it to de-duplicate against live chat messages. */
  id: number
  role: MessageRole
  /** Markdown text. Empty for system messages and pure file uploads. */
  text: string
  sources: Source[]
  suggestions: Suggestion[]
  /** Set when `role` is `system`. */
  event: SystemEvent | null
  /** ISO 8601 timestamp. */
  createdAt: string
}

/** A message received in a live chat. */
export interface LiveChatMessage {
  /** Server ID, `null` for a few server notices. Matches `HistoryMessage.id`. */
  id: number | null
  role: Exclude<MessageRole, 'assistant'>
  text: string
  file: ChatFile | null
  /** Set when `role` is `system`. */
  event: SystemEvent | null
  /** ISO 8601 timestamp. */
  createdAt: string
}

/**
 * Why a live chat ended.
 * `user_closed`: the visitor called `end()`. `admin_closed`: a team member closed it.
 * `already_closed`: it was over before you connected. `closed`: closed by the server, e.g. nobody answered in time.
 */
export type LiveChatEndReason = 'user_closed' | 'admin_closed' | 'already_closed' | 'closed'

/** Payloads of the events emitted by `LiveChat`. */
export interface LiveChatEvents {
  /** Connected and joined. Fires again after every reconnect: reload `history()` then to catch up. */
  ready: undefined
  /** A message from the team member, the system, or the echo of your own message. */
  message: LiveChatMessage
  status: { status: LiveChatState; mode: ChatMode }
  /** The team member started (`true`) or stopped (`false`) typing. */
  typing: boolean
  /** The live chat is over. Further messages go to the bot via `send()`. */
  ended: { reason: LiveChatEndReason }
  /** Connection lost. The client reconnects automatically. */
  disconnected: undefined
}

/** Result of `requestHuman()`. */
export type RequestHumanResult =
  | { ok: true }
  /** `tool_inactive`: live chat is switched off for this bot. `plan_not_supported`: the plan does not include live chat. */
  | { ok: false; reason: 'tool_inactive' | 'plan_not_supported' }

export interface RequestHumanOptions {
  /** Required when `config.features.askName` is true. */
  name?: string | undefined
  /** Required when `config.features.askEmail` is true. */
  email?: string | undefined
  /** Short note for the team member, e.g. what the visitor needs. */
  reason?: string | undefined
}

/** A prompt button configured in the dashboard. Show `title`, send `action` when clicked. */
export interface PromptButton {
  title: string
  action: string
}

/** Field types offered in the dashboard. `info` is display-only text (its `label`). */
export type FormFieldType = 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox' | 'number' | 'info'

export interface FormField {
  id: string
  type: FormFieldType
  label: string
  placeholder?: string | undefined
  required: boolean
  /** Choices for `select`. */
  options?: string[] | undefined
}

/** A lead form configured in the dashboard (Action Bar). */
export interface Form {
  id: string
  name: string
  fields: FormField[]
  submitLabel?: string | undefined
  /** Text to show after a successful `submitForm()`. */
  successMessage?: string | undefined
}

/** Values for `submitForm()`, keyed by `FormField.id`. */
export type FormValues = Record<string, string | number | boolean | undefined>

export interface ActionBarItem {
  id: string
  type: 'link' | 'whatsapp' | 'form' | 'calendly'
  label: string
  /** Icon preset key, e.g. `cart` or `help`. */
  icon?: string | undefined
  iconOnly?: boolean | undefined
  url?: string | undefined
  openInNewTab?: boolean | undefined
  phoneNumber?: string | undefined
  formId?: string | undefined
}

/**
 * Widget settings from the dashboard. Only fields useful for a custom UI are typed;
 * everything else is available as `unknown`.
 */
export interface WidgetSettings {
  title?: string
  welcomeMessage?: string
  welcomeImage?: string
  /** Bot avatar URL, may be empty. */
  avatarSrc?: string
  /** Hex colors. */
  themeColor?: string
  themeTextColor?: string
  botMessageColor?: string
  botMessageTextColor?: string
  userMessageColor?: string
  userMessageTextColor?: string
  fontFamily?: string
  /** Privacy notice as HTML. Show it before or below the chat. */
  privacyPolicyHtml?: string
  promptButtons?: PromptButton[]
  showSources?: boolean
  showVideos?: boolean
  disableVoiceInput?: boolean
  fileUploadEnabled?: boolean
  thumbsFeedbackEnabled?: boolean
  actionBar?: { enabled: boolean; items: ActionBarItem[] }
  forms?: Form[]
  liveChatAskName?: boolean
  liveChatAskEmail?: boolean
  [key: string]: unknown
}

/** Result of `getConfig()`. */
export interface ChatbotConfig {
  /** The chatbot was archived. Do not show the chat. */
  archived: boolean
  /** Settings of the floating widget. Use these for your UI. */
  widget: WidgetSettings
  /** Settings of the inline (embedded) widget. */
  inlineWidget: WidgetSettings
  /** What this chatbot allows, computed exactly like the server checks it. */
  features: {
    fileUpload: boolean
    feedback: boolean
    liveChat: boolean
    /** `requestHuman()` needs `name`. */
    askName: boolean
    /** `requestHuman()` needs `email`. */
    askEmail: boolean
  }
  /** Lead forms that can be submitted right now (active in the Action Bar). */
  forms: Form[]
  /** Minutes the widget waits for a team member before giving up. `0` = no client-side timeout. */
  liveChatTimeoutMinutes: number
  /**
   * "Powered by" notice. When `required` is `true` (plans without white-label branding)
   * you must show `text` linked to `url` in your chat UI.
   */
  branding: { required: boolean; text: string; url: string }
}

/** Error codes of `WebChatAgentError`. */
export type WebChatAgentErrorCode =
  /** No response, e.g. offline or blocked by CORS. */
  | 'NETWORK'
  /** Rejected by the SDK before sending, e.g. message too long or a required form field missing. */
  | 'INVALID_INPUT'
  /** The server returned an error status. See `status` and `message`. */
  | 'HTTP'
  /** Upload larger than allowed. */
  | 'FILE_TOO_LARGE'
  /** File type not allowed. */
  | 'UNSUPPORTED_TYPE'
  /** The answer stream broke off before it finished. */
  | 'STREAM_INTERRUPTED'
  /** `LiveChat.send()` without a waiting or open live chat. Call `requestHuman()` first. */
  | 'LIVE_CHAT_INACTIVE'
  /** The server did not confirm a live chat message in time. It may still arrive. */
  | 'TIMEOUT'
