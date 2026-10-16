import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebChatAgent, type LiveChat, type LiveChatEvents } from '../src/index.js'
import { bodyOf, CHATBOT_ID, FakeWebSocket, json, mockFetch, SESSION_ID } from './helpers.js'

function setup(fetch = mockFetch()): { chat: WebChatAgent; live: LiveChat; socket: FakeWebSocket; events: Array<[keyof LiveChatEvents, unknown]> } {
  const chat = new WebChatAgent({ chatbotId: CHATBOT_ID, sessionId: SESSION_ID, language: 'de', fetch, WebSocket: FakeWebSocket })
  const live = chat.liveChat()
  const events: Array<[keyof LiveChatEvents, unknown]> = []
  for (const name of ['ready', 'message', 'status', 'typing', 'ended', 'disconnected'] as const) {
    live.on(name, (payload) => events.push([name, payload]))
  }
  const socket = FakeWebSocket.last
  socket.open()
  return { chat, live, socket, events }
}

function join(socket: FakeWebSocket, status?: 'waiting' | 'open' | 'closed'): void {
  if (status) socket.receive({ type: 'livechat:status', chatbotId: CHATBOT_ID, sessionId: SESSION_ID, status, mode: status === 'closed' ? 'bot' : 'human' })
  socket.receive({ type: 'livechat:status', ok: true })
}

beforeEach(() => {
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LiveChat', () => {
  it('connects to the wss endpoint and joins as visitor', () => {
    const { socket } = setup()
    expect(socket.url).toBe('wss://webchatagent.com/api/livechat')
    expect(socket.sent[0]).toEqual({ type: 'client:join', as: 'user', lang: 'de', chatbotId: CHATBOT_ID, sessionId: SESSION_ID })
    expect(socket.sent[1]).toMatchObject({ type: 'client:meta', chatbotId: CHATBOT_ID, sessionId: SESSION_ID })
  })

  it('is idempotent while active', () => {
    const { chat, live } = setup()
    expect(chat.liveChat()).toBe(live)
    live.close()
    expect(chat.liveChat()).not.toBe(live)
  })

  it('emits ready, status, messages and agent typing', () => {
    const { live, socket, events } = setup()
    join(socket, 'waiting')
    socket.receive({ type: 'livechat:message', id: 5, sender: 'system', content: '__agent_joined__', createdAt: new Date('2026-10-16T10:00:00Z').toString() })
    socket.receive({ type: 'livechat:message', id: 6, sender: 'admin', content: 'Hi, Anna here.', createdAt: '2026-10-16T10:00:05.000Z' })
    socket.receive({ type: 'livechat:message', id: 7, sender: 'user', content: 'Bot answer copy', audience: 'admin', createdAt: '2026-10-16T10:00:06.000Z' })
    socket.receive({ type: 'livechat:typing', sender: 'admin', isTyping: true })
    socket.receive({ type: 'livechat:typing', sender: 'user', isTyping: true })
    expect(live.ready).toBe(true)
    expect(live.status).toBe('waiting')
    expect(events).toEqual([
      ['status', { status: 'waiting', mode: 'human' }],
      ['ready', undefined],
      ['message', { id: 5, role: 'system', text: '', file: null, event: 'agent_joined', createdAt: '2026-10-16T10:00:00.000Z' }],
      ['message', { id: 6, role: 'agent', text: 'Hi, Anna here.', file: null, event: null, createdAt: '2026-10-16T10:00:05.000Z' }],
      ['typing', true],
    ])
  })

  it('refuses to send before a handover was requested', async () => {
    const { live, socket } = setup()
    join(socket)
    expect(live.canSend).toBe(false)
    await expect(live.send('Hello')).rejects.toMatchObject({ code: 'LIVE_CHAT_INACTIVE' })
    await expect(live.upload(new Blob(['x']), 'a.txt')).rejects.toMatchObject({ code: 'LIVE_CHAT_INACTIVE' })
    socket.receive({ type: 'livechat:status', status: 'waiting', mode: 'human' })
    expect(live.canSend).toBe(true)
    expect(socket.sent.filter((f) => f['type'] === 'client:message')).toEqual([])
  })

  it('sends messages with ids and resolves on the echo', async () => {
    const { live, socket } = setup()
    join(socket, 'open')
    const sent = live.send('  Where is my order?  ')
    expect(socket.sent.at(-1)).toEqual({ type: 'client:message', sender: 'user', content: 'Where is my order?', chatbotId: CHATBOT_ID, sessionId: SESSION_ID })
    socket.receive({ type: 'livechat:message', id: 9, sessionId: SESSION_ID, sender: 'user', content: 'Where is my order?', createdAt: '2026-10-16T10:02:00.000Z' })
    await expect(sent).resolves.toMatchObject({ id: 9, role: 'user', text: 'Where is my order?' })
  })

  it('times out when the echo never arrives', async () => {
    vi.useFakeTimers()
    const { live, socket } = setup()
    join(socket, 'open')
    const sent = live.send('Hello')
    vi.advanceTimersByTime(15000)
    await expect(sent).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('ends once with the server reason and stops reconnecting', () => {
    vi.useFakeTimers()
    const { live, socket, events } = setup()
    join(socket, 'open')
    socket.receive({ type: 'livechat:ended', chatbotId: CHATBOT_ID, sessionId: SESSION_ID, reason: 'admin_closed' })
    socket.receive({ type: 'livechat:status', status: 'closed', mode: 'bot' })
    expect(events.filter(([name]) => name === 'ended')).toEqual([['ended', { reason: 'admin_closed' }]])
    expect(live.active).toBe(false)
    vi.advanceTimersByTime(10000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('treats a server-side close of a waiting chat as ended', () => {
    const { socket, events } = setup()
    join(socket, 'waiting')
    socket.receive({ type: 'livechat:status', status: 'closed', mode: 'bot' })
    expect(events.at(-1)).toEqual(['ended', { reason: 'closed' }])
  })

  it('reports already closed sessions on join', () => {
    const { socket, events } = setup()
    socket.receive({ type: 'livechat:status', status: 'closed', mode: 'bot' })
    socket.receive({ type: 'livechat:ended', sessionId: SESSION_ID, reason: 'already_closed' })
    expect(events.filter(([name]) => name === 'ended')).toEqual([['ended', { reason: 'already_closed' }]])
  })

  it('reconnects and rejoins after a dropped connection', () => {
    vi.useFakeTimers()
    const { socket, events } = setup()
    join(socket, 'open')
    socket.drop()
    expect(events.at(-1)).toEqual(['disconnected', undefined])
    vi.advanceTimersByTime(3000)
    const next = FakeWebSocket.last
    expect(next).not.toBe(socket)
    next.open()
    expect(next.sent[0]).toMatchObject({ type: 'client:join', as: 'user' })
  })

  it('does not reconnect after close()', () => {
    vi.useFakeTimers()
    const { live, socket } = setup()
    join(socket, 'open')
    live.close()
    socket.drop()
    vi.advanceTimersByTime(10000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('ends via REST', async () => {
    const fetch = mockFetch(json({ messages: [] }), json({ ok: true }))
    const { live, socket, events } = setup(fetch)
    join(socket, 'open')
    await live.end()
    expect(fetch.calls[1]?.url).toBe('https://webchatagent.com/api/livechats/end')
    expect(bodyOf(fetch.calls[1])).toEqual({ chatbotId: CHATBOT_ID, sessionId: SESSION_ID })
    expect(events.at(-1)).toEqual(['ended', { reason: 'user_closed' }])
    expect(socket.readyState).toBe(3)
  })

  it('uploads files as visitor', async () => {
    const fetch = mockFetch(
      json({ messages: [] }),
      json({ ok: true, uploadId: 'l1', messageId: 3, file: { kind: 'file', uploadId: 'l1', name: 'photo.jpg', mimeType: 'image/jpeg', size: 1, url: '/api/livechat/upload/l1', isImage: true } }),
    )
    const { live, socket } = setup(fetch)
    join(socket, 'open')
    const file = await live.upload(new Blob(['x']), 'photo.jpg')
    const form = fetch.calls[1]?.init.body
    if (!(form instanceof FormData)) throw new Error('expected FormData')
    expect(fetch.calls[1]?.url).toBe('https://webchatagent.com/api/livechat/upload')
    expect(form.get('as')).toBe('user')
    expect(file.url).toBe('https://webchatagent.com/api/livechat/upload/l1')
  })

  it('sends typing changes only', () => {
    const { live, socket } = setup()
    join(socket, 'open')
    live.typing(true)
    live.typing(true)
    live.typing(false)
    expect(socket.sent.filter((f) => f['type'] === 'client:typing').map((f) => f['isTyping'])).toEqual([true, false])
  })

  it('backs off between reconnect attempts', () => {
    vi.useFakeTimers()
    const { socket } = setup()
    socket.drop()
    vi.advanceTimersByTime(3000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.last.drop()
    vi.advanceTimersByTime(5999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('delivers messages missed while disconnected', async () => {
    vi.useFakeTimers()
    const row = (id: number, role: string, isAgent: boolean, text: string) => ({ id, sender: role === 'user' ? 'user' : 'bot', role, isAgent, text, sources: null, createdAt: '2026-10-16T10:00:00.000Z' })
    const fetch = mockFetch(
      json({ messages: [row(1, 'user', false, 'Hi'), row(2, 'assistant', true, 'Hello, Anna here.')] }),
      json({ messages: [row(1, 'user', false, 'Hi'), row(2, 'assistant', true, 'Hello, Anna here.'), row(3, 'assistant', true, 'Are you still there?'), row(4, 'assistant', false, 'Bot answer')] }),
    )
    const { socket, events } = setup(fetch)
    join(socket, 'open')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.filter(([name]) => name === 'message')).toEqual([])
    socket.drop()
    await vi.advanceTimersByTimeAsync(3000)
    FakeWebSocket.last.open()
    join(FakeWebSocket.last)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.filter(([name]) => name === 'message')).toEqual([
      ['message', { id: 3, role: 'agent', text: 'Are you still there?', file: null, event: null, createdAt: '2026-10-16T10:00:00.000Z' }],
    ])
    FakeWebSocket.last.receive({ type: 'livechat:message', id: 3, sender: 'admin', content: 'Are you still there?', createdAt: '2026-10-16T10:00:00.000Z' })
    expect(events.filter(([name]) => name === 'message')).toHaveLength(1)
  })

  it('keeps the connection alive with a ping', () => {
    vi.useFakeTimers()
    const { live, socket } = setup()
    join(socket, 'open')
    vi.advanceTimersByTime(45000)
    expect(socket.sent.at(-1)).toEqual({ type: 'client:ping', chatbotId: CHATBOT_ID, sessionId: SESSION_ID })
    live.close()
    const sent = socket.sent.length
    vi.advanceTimersByTime(90000)
    expect(socket.sent).toHaveLength(sent)
  })
})
