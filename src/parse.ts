import type { ChatFile, FileSourceData, ProductSourceData, Source, Suggestion, SystemEvent } from './types.js'

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** RFC 4122 v4 UUID. Uses `getRandomValues`, which (unlike `randomUUID`) also works on plain http pages. */
export function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Yields the JSON payload of every `data:` frame of a server-sent event stream. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonObject, void, undefined> {
  // ponytail: getReader() instead of `for await (body)`, Safari has no async iteration on ReadableStream.
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = done ? '' : (blocks.pop() ?? '')
      for (const block of blocks) {
        const frame = parseFrame(block)
        if (frame) yield frame
      }
      if (done) return
    }
  } finally {
    // Early exit (break, abort, error): closing the body tells the server to stop generating.
    reader.cancel().catch(() => undefined)
  }
}

function parseFrame(block: string): JsonObject | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!data) return null
  try {
    const parsed: unknown = JSON.parse(data)
    return isObject(parsed) && typeof parsed['type'] === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Makes a partially streamed Markdown answer safe to display: drops reasoning blocks,
 * the suggestion comment and half-written links, tags, entities and emphasis at the end.
 * Ported from the official widget so custom UIs behave the same.
 */
export function cleanStreamingText(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const thinkOpen = text.lastIndexOf('<think>')
  if (thinkOpen !== -1) text = text.slice(0, thinkOpen)

  text = text.replace(/<[!/-]*$/, '')
  text = text.replace(/&[#a-zA-Z0-9]*$/, (m) => (/^&[#a-zA-Z]/.test(m) ? '' : m))

  for (const marker of ['![', '[']) {
    const at = text.lastIndexOf(marker)
    if (at !== -1 && /^!?\[[^\]]*(\]\([^)]*)?$/.test(text.slice(at))) text = text.slice(0, at)
  }

  const buttons = text.indexOf('<!-- SUGGESTED_BUTTONS')
  if (buttons !== -1) text = text.slice(0, buttons).trimEnd()
  const comment = text.lastIndexOf('<!--')
  if (comment !== -1 && !text.includes('-->', comment)) text = text.slice(0, comment).trimEnd()

  // Unclosed bold: hide it until the closing marker arrives.
  if ((text.match(/\*\*/g)?.length ?? 0) % 2 === 1) text = text.slice(0, text.lastIndexOf('**'))
  // A lone trailing `*` or `~` may be the start of a marker.
  text = text.replace(/(?:(?<!\*)\*|~{1,2})$/, '')

  return text
}

const SUGGESTIONS_RE = /<!--\s*SUGGESTED_BUTTONS:\s*(\[[\s\S]*?\])\s*-->/

/** Splits the bot's hidden suggestion comment off a final answer. */
export function extractSuggestions(markdown: string): { text: string; suggestions: Suggestion[] } {
  const match = SUGGESTIONS_RE.exec(markdown)
  if (!match) return { text: markdown.trim(), suggestions: [] }
  let parsed: unknown = []
  try {
    parsed = JSON.parse(match[1] ?? '[]')
  } catch {
    parsed = []
  }
  const suggestions = (Array.isArray(parsed) ? parsed : [])
    .filter(isObject)
    .map((item) => ({ label: asString(item['label']).trim(), text: asString(item['text']).trim() }))
    .filter((s) => s.label && s.text)
  return { text: markdown.replace(SUGGESTIONS_RE, '').trim(), suggestions }
}

const SYSTEM_EVENTS: Record<string, SystemEvent> = {
  __agent_joined__: 'agent_joined',
  __livechat_ended__: 'ended',
  __livechat_timeout__: 'timeout',
}

/** Maps the server's system message tokens to `SystemEvent`. */
export function systemEvent(content: string): SystemEvent | null {
  return SYSTEM_EVENTS[content.trim()] ?? null
}

/** The server sends ISO strings and sometimes `Date.prototype.toString()` output. */
export function toIsoDate(value: unknown): string {
  const date = new Date(typeof value === 'string' || typeof value === 'number' ? value : Number.NaN)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** Resolves `url` against `base`. Anything but http(s) (e.g. `javascript:`) becomes `''`, so it is safe for `href`/`src`. */
export function absoluteUrl(url: string, base: string): string {
  if (!url) return ''
  try {
    const resolved = new URL(url, base)
    return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.href : ''
  } catch {
    return ''
  }
}

export function parseFile(value: unknown, base: string): ChatFile | null {
  if (!isObject(value)) return null
  const uploadId = asString(value['uploadId'])
  if (!uploadId) return null
  return {
    uploadId,
    name: asString(value['name']),
    mimeType: asString(value['mimeType']),
    size: typeof value['size'] === 'number' ? value['size'] : 0,
    url: absoluteUrl(asString(value['url']), base),
    isImage: value['isImage'] === true,
  }
}

export function parseSources(value: unknown, base: string): Source[] {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).flatMap((item): Source[] => {
    const source = asString(item['source'])
    const data = item['data']
    switch (item['type']) {
      case 'web': {
        const url = absoluteUrl(source, base)
        return url ? [{ type: 'web', source: url }] : []
      }
      case 'product':
        return [isObject(data) ? { type: 'product', source, data: productData(data) } : { type: 'product', source }]
      case 'fileSource':
        return [isObject(data) ? { type: 'fileSource', source, data: fileSourceData(data) } : { type: 'fileSource', source }]
      case 'file': {
        const url = absoluteUrl(source, base)
        const file = url ? parseFile(isObject(data) ? { ...data, url } : null, base) : null
        return file ? [{ type: 'file', source: url, data: file }] : []
      }
      default:
        return []
    }
  })
}

function productData(data: JsonObject): ProductSourceData {
  return {
    id: asString(data['id']),
    dataType: asString(data['dataType']),
    format: asString(data['format']),
    data: data['data'],
    sourceUrl: asString(data['sourceUrl']),
  }
}

function fileSourceData(data: JsonObject): FileSourceData {
  const result: FileSourceData = { name: asString(data['name']) }
  for (const key of ['path', 'provider', 'webUrl'] as const) {
    const value = data[key]
    if (typeof value === 'string') result[key] = value
  }
  return result
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Reads a human-readable message from any of the server's four error body shapes. */
export function errorMessage(body: unknown, status: number): string {
  if (isObject(body)) {
    if (typeof body['reply'] === 'string' && body['reply']) return stripHtml(body['reply'])
    if (typeof body['error'] === 'string' && body['error']) return body['error']
    if (typeof body['message'] === 'string' && body['message']) return body['message']
    if (typeof body['statusMessage'] === 'string' && body['statusMessage']) return body['statusMessage']
  }
  return `Request failed with status ${status}`
}
