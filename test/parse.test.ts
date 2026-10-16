import { describe, expect, it } from 'vitest'
import {
  cleanStreamingText,
  errorMessage,
  extractSuggestions,
  isUuid,
  parseSources,
  randomUuid,
  readSseFrames,
  systemEvent,
  toIsoDate,
} from '../src/parse.js'
import { sse } from './helpers.js'

async function frames(chunks: Array<string | Uint8Array>): Promise<unknown[]> {
  const body = sse(chunks)().body
  if (!body) throw new Error('no body')
  const out: unknown[] = []
  for await (const frame of readSseFrames(body)) out.push(frame)
  return out
}

describe('readSseFrames', () => {
  it('parses the server contract frames', async () => {
    // tests/unit/__snapshots__/chat-sse-contract.test.ts.snap in the WebChatAgent app
    const result = await frames([
      'data: {"type":"token","data":"Wir liefern "}\n\n',
      'data: {"type":"token","data":"in zwei bis drei Werktagen."}\n\n',
      'data: {"type":"done","reply":"Wir liefern in zwei bis drei Werktagen.","sources":[],"conversationTooLong":false,"aiGenerated":true}\n\n',
    ])
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({ type: 'done', aiGenerated: true })
  })

  it('handles frames split across chunks, several frames per chunk and split UTF-8 characters', async () => {
    const bytes = new TextEncoder().encode('data: {"type":"token","data":"Grüße"}\n\n')
    const cut = bytes.indexOf(0xc3) + 1 // inside the two-byte "ü"
    const result = await frames([
      bytes.slice(0, cut),
      bytes.slice(cut),
      'data: {"type":"token","data":"a"}\n\ndata: {"type":"tool_call","name":"x"}\n\n',
      ': comment\n\ndata: {"type":"done","reply":"end"}',
    ])
    expect(result).toEqual([
      { type: 'token', data: 'Grüße' },
      { type: 'token', data: 'a' },
      { type: 'tool_call', name: 'x' },
      { type: 'done', reply: 'end' },
    ])
  })

  it('skips frames that are not JSON objects with a type', async () => {
    expect(await frames(['data: nope\n\ndata: [1]\n\ndata: {"a":1}\n\n'])).toEqual([])
  })
})

describe('cleanStreamingText', () => {
  it.each([
    ['Hello <think>secret</think>world', 'Hello world'],
    ['Hello <think>still thinking', 'Hello '],
    ['See [our page](https://exa', 'See '],
    ['See [our pa', 'See '],
    ['Look ![img](https://x', 'Look '],
    ['Done.\n\n<!-- SUGGESTED_BUTTONS: [{"label":"A"', 'Done.'],
    ['Done. <!-', 'Done. '],
    ['This is **bol', 'This is '],
    ['This is **bold*', 'This is '],
    ['A list item *', 'A list item '],
    ['Fish &amp', 'Fish '],
    ['Fish & chips', 'Fish & chips'],
    ['Complete [link](https://a.b) and **bold**', 'Complete [link](https://a.b) and **bold**'],
  ])('%j -> %j', (input, expected) => {
    expect(cleanStreamingText(input)).toBe(expected)
  })
})

describe('extractSuggestions', () => {
  it('splits the suggestion comment off', () => {
    const result = extractSuggestions('Answer.\n<!-- SUGGESTED_BUTTONS: [{"label":"Prices","text":"What does it cost?"},{"label":""}] -->')
    expect(result).toEqual({ text: 'Answer.', suggestions: [{ label: 'Prices', text: 'What does it cost?' }] })
  })

  it('removes a broken comment without suggestions', () => {
    expect(extractSuggestions('A <!-- SUGGESTED_BUTTONS: [oops] -->')).toEqual({ text: 'A', suggestions: [] })
  })
})

describe('helpers', () => {
  it('creates v4 UUIDs', () => {
    const id = randomUuid()
    expect(isUuid(id)).toBe(true)
    expect(id[14]).toBe('4')
    expect(randomUuid()).not.toBe(id)
  })

  it('maps system tokens', () => {
    expect(systemEvent('__agent_joined__')).toBe('agent_joined')
    expect(systemEvent('__livechat_timeout__')).toBe('timeout')
    expect(systemEvent('hello')).toBeNull()
  })

  it('normalizes Date.toString() output to ISO', () => {
    const date = new Date('2026-10-16T12:00:00.000Z')
    expect(toIsoDate(date.toString())).toBe('2026-10-16T12:00:00.000Z')
    expect(toIsoDate('2026-10-16T12:00:00.000Z')).toBe('2026-10-16T12:00:00.000Z')
  })

  it('reads all four error body shapes', () => {
    expect(errorMessage({ error: true, statusCode: 429, message: 'Too many requests' }, 429)).toBe('Too many requests')
    expect(errorMessage({ reply: '<p>The chat is temporarily unavailable.</p>', sources: [] }, 429)).toBe('The chat is temporarily unavailable.')
    expect(errorMessage({ error: 'Invalid chatbotId' }, 400)).toBe('Invalid chatbotId')
    expect(errorMessage({ ok: false, code: 'FILE_TOO_LARGE' }, 413)).toBe('Request failed with status 413')
  })

  it('parses sources and makes file URLs absolute', () => {
    const sources = parseSources(
      [
        { type: 'web', source: 'https://shop.example/faq' },
        { type: 'file', source: '/api/ai-chat/upload/u1', data: { name: 'a.pdf', mimeType: 'application/pdf', size: 3, isImage: false, uploadId: 'u1' } },
        { type: 'fileSource', source: 'r1', data: { name: 'Handbook.docx', provider: 'sharepoint' } },
        { type: 'unknown' },
        { type: 'web', source: 'javascript:alert(1)' },
        { type: 'file', source: 'javascript:alert(1)', data: { name: 'x', uploadId: 'u2' } },
      ],
      'https://webchatagent.com',
    )
    expect(sources).toEqual([
      { type: 'web', source: 'https://shop.example/faq' },
      {
        type: 'file',
        source: 'https://webchatagent.com/api/ai-chat/upload/u1',
        data: { uploadId: 'u1', name: 'a.pdf', mimeType: 'application/pdf', size: 3, url: 'https://webchatagent.com/api/ai-chat/upload/u1', isImage: false },
      },
      { type: 'fileSource', source: 'r1', data: { name: 'Handbook.docx', provider: 'sharepoint' } },
    ])
  })
})
