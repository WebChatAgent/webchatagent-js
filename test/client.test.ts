import { describe, expect, it } from 'vitest'
import { WebChatAgent, WebChatAgentError, type ChatStreamEvent, type StorageLike } from '../src/index.js'
import { bodyOf, CHATBOT_ID, headersOf, json, mockFetch, SESSION_ID, sse } from './helpers.js'

function client(fetch: ReturnType<typeof mockFetch>, extra: { storage?: StorageLike; language?: string } = {}): WebChatAgent {
  return new WebChatAgent({ chatbotId: CHATBOT_ID, sessionId: SESSION_ID, fetch, ...extra })
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function rejection(promise: Promise<unknown>): Promise<WebChatAgentError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(error instanceof WebChatAgentError)) throw new Error(`expected WebChatAgentError, got ${String(error)}`)
  return error
}

describe('constructor', () => {
  it('validates options', () => {
    expect(() => new WebChatAgent({ chatbotId: 'abc' })).toThrow(WebChatAgentError)
    expect(() => new WebChatAgent({ chatbotId: CHATBOT_ID, sessionId: 'wa_123' })).toThrow(/UUID/)
    expect(() => new WebChatAgent({ chatbotId: CHATBOT_ID, baseUrl: 'ftp://x' })).toThrow(/https/)
    expect(new WebChatAgent({ chatbotId: CHATBOT_ID, baseUrl: 'https://chat.example.com/some/path/' }).baseUrl).toBe('https://chat.example.com')
  })
})

describe('sessions', () => {
  it('creates a UUID lazily and persists it per chatbot', () => {
    const store = new Map<string, string>()
    const storage: StorageLike = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }
    const chat = new WebChatAgent({ chatbotId: CHATBOT_ID, storage })
    expect(store.size).toBe(0)
    const id = chat.sessionId
    expect(store.get(`webchatagent:session:${CHATBOT_ID}`)).toBe(id)
    expect(new WebChatAgent({ chatbotId: CHATBOT_ID, storage }).sessionId).toBe(id)
    chat.reset()
    expect(chat.sessionId).not.toBe(id)
    expect(store.get(`webchatagent:session:${CHATBOT_ID}`)).toBe(chat.sessionId)
  })

  it('works when storage throws', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(new WebChatAgent({ chatbotId: CHATBOT_ID, storage }).sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('adopts a session ID assigned by the server', async () => {
    const other = '99999999-8888-4777-8666-555555555555'
    const fetch = mockFetch(json({ reply: 'Hi', sources: [], aiGenerated: true }, 200, { 'x-chat-session-id': other }))
    const chat = client(fetch)
    await chat.send('Hi')
    expect(chat.sessionId).toBe(other)
  })
})

describe('send', () => {
  it('posts the message and parses the reply', async () => {
    const fetch = mockFetch(
      json({
        reply: 'We ship in **2 days**.\n<!-- SUGGESTED_BUTTONS: [{"label":"Costs","text":"What does shipping cost?"}] -->',
        sources: [{ type: 'web', source: 'https://shop.example/shipping' }],
        conversationTooLong: false,
        aiGenerated: true,
      }),
    )
    const reply = await client(fetch, { language: 'de' }).send('How fast?', { contextData: { plan: 'pro' } })

    const call = fetch.calls[0]
    expect(call?.url).toBe('https://webchatagent.com/api/chat')
    expect(headersOf(call)).toEqual({
      'Accept-Language': 'de',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Chat-Session-Id': SESSION_ID,
    })
    expect(bodyOf(call)).toEqual({ message: 'How fast?', chatbotId: CHATBOT_ID, contextData: { plan: 'pro' } })
    expect(reply).toMatchObject({
      question: 'How fast?',
      text: 'We ship in **2 days**.',
      suggestions: [{ label: 'Costs', text: 'What does shipping cost?' }],
      sources: [{ type: 'web', source: 'https://shop.example/shipping' }],
      mode: 'bot',
      status: null,
      aiGenerated: true,
    })
    expect(reply.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('detects a human handover from the gate replies', async () => {
    const fetch = mockFetch(
      json({ reply: 'A team member will join shortly.', sources: [] }),
      json({ reply: '', sources: [], _liveChatOpen: true }),
      json({ reply: 'Connecting you.', sources: [], mode: 'human', status: 'waiting', aiGenerated: true }),
    )
    const chat = client(fetch)
    expect(await chat.send('a')).toMatchObject({ mode: 'human', status: 'waiting', aiGenerated: false })
    expect(await chat.send('b')).toMatchObject({ mode: 'human', status: 'open', text: '' })
    expect(await chat.send('c')).toMatchObject({ mode: 'human', status: 'waiting', aiGenerated: true })
  })

  it('rejects invalid messages without a request', async () => {
    const fetch = mockFetch()
    const chat = client(fetch)
    expect((await rejection(chat.send('x'.repeat(701)))).code).toBe('INVALID_INPUT')
    expect((await rejection(chat.send('   '))).code).toBe('INVALID_INPUT')
    expect(fetch.calls).toHaveLength(0)
  })

  it('turns every error shape into a WebChatAgentError', async () => {
    const fetch = mockFetch(
      json({ error: true, statusCode: 429, statusMessage: 'Too Many Requests', message: 'Too many requests, slow down.' }, 429),
      json({ reply: '<p>The chat is temporarily unavailable.</p>', sources: [] }, 429),
      () => {
        throw new TypeError('Failed to fetch')
      },
    )
    const chat = client(fetch)
    expect(await rejection(chat.send('a'))).toMatchObject({ code: 'HTTP', status: 429, message: 'Too many requests, slow down.' })
    expect(await rejection(chat.send('b'))).toMatchObject({ code: 'HTTP', status: 429, message: 'The chat is temporarily unavailable.' })
    expect(await rejection(chat.send('c'))).toMatchObject({ code: 'NETWORK', status: 0 })
  })

  it('passes AbortError through', async () => {
    const fetch = mockFetch(() => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(client(fetch).send('a')).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('stream', () => {
  it('yields cleaned text and the final reply', async () => {
    const fetch = mockFetch(
      sse([
        'data: {"type":"token","data":"We ship "}\n\n',
        'data: {"type":"tool_call","name":"searchProducts"}\n\n',
        'data: {"type":"token","data":"in [2 days](https://shop.ex"}\n\n',
        'data: {"type":"token","data":"ample/shipping)."}\n\n',
        'data: {"type":"done","reply":"We ship in [2 days](https://shop.example/shipping).","sources":[],"mode":"bot","conversationTooLong":false,"aiGenerated":true}\n\n',
      ]),
    )
    const events = await collect(client(fetch).stream('How fast?'))
    expect(headersOf(fetch.calls[0])['Accept']).toBe('text/event-stream')
    expect(events).toEqual([
      { type: 'text', text: 'We ship ', delta: 'We ship ' },
      { type: 'tool', name: 'searchProducts' },
      { type: 'text', text: 'We ship in ', delta: 'in ' },
      { type: 'text', text: 'We ship in [2 days](https://shop.example/shipping).', delta: '[2 days](https://shop.example/shipping).' },
      { type: 'done', reply: expect.objectContaining({ text: 'We ship in [2 days](https://shop.example/shipping).', mode: 'bot' }) },
    ])
  })

  it('yields a single done event when the server answers with JSON', async () => {
    const fetch = mockFetch(json({ reply: 'Cached answer', sources: [], aiGenerated: true }))
    const events = await collect(client(fetch).stream('Hi'))
    expect(events).toEqual([{ type: 'done', reply: expect.objectContaining({ text: 'Cached answer' }) }])
  })

  it('throws with the server message when the stream ends without done', async () => {
    const fetch = mockFetch(sse(['data: {"type":"error","data":"Model overloaded"}\n\n']))
    const error = await rejection(collect(client(fetch).stream('Hi')))
    expect(error).toMatchObject({ code: 'STREAM_INTERRUPTED', message: 'Model overloaded' })
  })

  it('cancels the request when the consumer stops early', async () => {
    let cancelled = false
    const fetch = mockFetch(
      sse(['data: {"type":"token","data":"A"}\n\n', 'data: {"type":"token","data":"B"}\n\n'], () => {
        cancelled = true
      }),
    )
    for await (const event of client(fetch).stream('Hi')) {
      expect(event.type).toBe('text')
      break
    }
    expect(cancelled).toBe(true)
  })
})

describe('history', () => {
  it('maps roles, system events, suggestions and file URLs', async () => {
    const fetch = mockFetch(
      json({
        messages: [
          { id: 1, sender: 'user', role: 'user', isAgent: false, text: 'invoice.pdf', sources: [{ type: 'file', source: '/api/ai-chat/upload/u1', data: { name: 'invoice.pdf', mimeType: 'application/pdf', size: 10, isImage: false, uploadId: 'u1' } }], createdAt: '2026-10-16T10:00:00.000Z' },
          { id: 2, sender: 'bot', role: 'assistant', isAgent: false, text: 'Total: 12 €\n<!-- SUGGESTED_BUTTONS: [{"label":"Pay","text":"How can I pay?"}] -->', sources: null, createdAt: '2026-10-16T10:00:01.000Z' },
          { id: 3, sender: 'bot', role: 'system', isAgent: false, text: '__agent_joined__', sources: null, createdAt: '2026-10-16T10:01:00.000Z' },
          { id: 4, sender: 'bot', role: 'assistant', isAgent: true, text: 'Hi, Anna here.', sources: null, createdAt: '2026-10-16T10:01:05.000Z' },
        ],
        conversationTooLong: false,
      }),
    )
    const messages = await client(fetch).history()
    expect(fetch.calls[0]?.url).toBe(`https://webchatagent.com/api/chat/history?chatbotId=${CHATBOT_ID}&sessionId=${SESSION_ID}`)
    expect(messages.map((m) => [m.id, m.role, m.text, m.event])).toEqual([
      [1, 'user', 'invoice.pdf', null],
      [2, 'assistant', 'Total: 12 €', null],
      [3, 'system', '', 'agent_joined'],
      [4, 'agent', 'Hi, Anna here.', null],
    ])
    expect(messages[0]?.sources[0]).toMatchObject({ type: 'file', source: 'https://webchatagent.com/api/ai-chat/upload/u1' })
    expect(messages[1]?.suggestions).toEqual([{ label: 'Pay', text: 'How can I pay?' }])
  })

  it('returns an empty list for expired conversations', async () => {
    const fetch = mockFetch(json({ error: true, statusCode: 410, message: 'Gone' }, 410))
    expect(await client(fetch).history()).toEqual([])
  })
})

describe('getConfig', () => {
  it('computes features, active forms and branding', async () => {
    const form = { id: 'f1', name: 'Callback', fields: [{ id: 'n', type: 'text', label: 'Name', required: true }] }
    const fetch = mockFetch(
      json({
        widgetProperties: {
          title: 'Shop Bot',
          promptButtons: [{ title: 'Hours', action: 'When are you open?', _uid: 'x' }],
          thumbsFeedbackEnabled: true,
          liveChatAskName: true,
          actionBar: { enabled: true, items: [{ id: 'i1', type: 'form', label: 'Call me', formId: 'f1' }] },
          forms: [form, { id: 'f2', name: 'Unused', fields: [] }],
        },
        embeddedWidgetProperties: { fileUploadEnabled: true },
        canHideBranding: false,
        liveChatActive: true,
        liveChatTimeoutMinutes: 5,
        toolFeedbackActive: true,
        poweredByText: 'Powered by WebChatAgent',
        poweredByUrl: 'https://webchatagent.com',
      }),
    )
    const config = await client(fetch).getConfig()
    expect(config.widget.title).toBe('Shop Bot')
    expect(config.widget.promptButtons).toEqual([{ title: 'Hours', action: 'When are you open?' }])
    expect(config.features).toEqual({ fileUpload: true, feedback: true, liveChat: true, askName: true, askEmail: false })
    expect(config.forms).toEqual([form])
    expect(config.branding).toEqual({ required: true, text: 'Powered by WebChatAgent', url: 'https://webchatagent.com' })
  })

  it('handles archived chatbots', async () => {
    const fetch = mockFetch(json({ archived: true, widgetProperties: { widgetDisabled: true } }))
    const config = await client(fetch).getConfig()
    expect(config.archived).toBe(true)
    expect(config.forms).toEqual([])
  })
})

describe('upload, feedback, forms, handover', () => {
  it('uploads multipart and returns an absolute URL', async () => {
    const fetch = mockFetch(
      json({ ok: true, uploadId: 'u1', messageId: 7, file: { kind: 'file', uploadId: 'u1', name: 'a.png', mimeType: 'image/png', size: 4, url: '/api/ai-chat/upload/u1', isImage: true } }),
    )
    const file = await client(fetch, { language: 'de' }).upload(new Blob(['abcd'], { type: 'image/png' }), 'a.png')
    const form = fetch.calls[0]?.init.body
    if (!(form instanceof FormData)) throw new Error('expected FormData')
    expect([...form.keys()]).toEqual(['file', 'chatbotId', 'sessionId', 'lang'])
    expect((form.get('file') as File).name).toBe('a.png')
    expect(file).toEqual({ uploadId: 'u1', messageId: 7, name: 'a.png', mimeType: 'image/png', size: 4, url: 'https://webchatagent.com/api/ai-chat/upload/u1', isImage: true })
  })

  it('maps upload error codes', async () => {
    const fetch = mockFetch(json({ ok: false, code: 'FILE_TOO_LARGE', maxBytes: 2097152 }, 413))
    expect(await rejection(client(fetch).upload(new Blob(['x'])))).toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 })
  })

  it('sends feedback for a reply', async () => {
    const fetch = mockFetch(json({ reply: 'Yes.', sources: [], aiGenerated: true }), json({ success: true }))
    const chat = client(fetch, { language: 'en' })
    const reply = await chat.send('Open on Sunday?')
    await chat.feedback(reply, 'up')
    expect(bodyOf(fetch.calls[1])).toEqual({
      chatbotId: CHATBOT_ID,
      sessionId: SESSION_ID,
      messageId: reply.id,
      rating: 'up',
      answer: 'Yes.',
      question: 'Open on Sunday?',
      language: 'en',
    })
  })

  it('validates forms and keys values by label', async () => {
    const form = {
      id: 'f1',
      name: 'Callback',
      fields: [
        { id: 'n', type: 'text' as const, label: 'Name', required: true },
        { id: 'e', type: 'email' as const, label: 'E-Mail', required: false },
        { id: 'i', type: 'info' as const, label: 'We call back within a day.', required: false },
        { id: 'c', type: 'checkbox' as const, label: 'Newsletter', required: false },
      ],
    }
    const fetch = mockFetch(json({ ok: true }))
    const chat = client(fetch)
    expect(await rejection(chat.submitForm(form, { e: 'nope' }))).toMatchObject({ code: 'INVALID_INPUT', body: { missing: ['n'], invalid: ['e'] } })
    await chat.submitForm(form, { n: 'Jane', e: '', c: true })
    expect(bodyOf(fetch.calls[0])).toEqual({
      chatbotId: CHATBOT_ID,
      sessionId: SESSION_ID,
      formId: 'f1',
      formName: 'Callback',
      data: { Name: 'Jane', Newsletter: true },
    })
  })

  it('requests a human and reads the live chat status', async () => {
    const fetch = mockFetch(json({ ok: false, reason: 'plan_not_supported' }), json({ ok: true }), json({ exists: false }), json({ exists: true, status: 'open', mode: 'human' }))
    const chat = client(fetch, { language: 'de' })
    expect(await chat.requestHuman({ name: 'Jane', reason: 'Order' })).toEqual({ ok: false, reason: 'plan_not_supported' })
    expect(await chat.requestHuman()).toEqual({ ok: true })
    expect(headersOf(fetch.calls[0])['X-Chat-Session-Id']).toBe(SESSION_ID)
    expect(bodyOf(fetch.calls[0])).toEqual({ chatbotId: CHATBOT_ID, name: 'Jane', reason: 'Order', userLanguage: 'de' })
    expect(await chat.liveChatStatus()).toBeNull()
    expect(await chat.liveChatStatus()).toEqual({ status: 'open', mode: 'human' })
  })
})
