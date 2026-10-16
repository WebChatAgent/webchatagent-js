import { describe, expectTypeOf, it } from 'vitest'
import type { ChatReply, ChatStreamEvent, Source, StorageLike, WebSocketConstructorLike } from '../src/index.js'

describe('public types', () => {
  it('accepts platform objects for storage and WebSocket', () => {
    expectTypeOf<Storage>().toExtend<StorageLike>()
    expectTypeOf<typeof WebSocket>().toExtend<WebSocketConstructorLike>()
  })

  it('narrows stream events and sources', () => {
    expectTypeOf<Extract<ChatStreamEvent, { type: 'done' }>['reply']>().toEqualTypeOf<ChatReply>()
    expectTypeOf<Extract<ChatStreamEvent, { type: 'text' }>>().toEqualTypeOf<{ type: 'text'; text: string; delta: string }>()
    expectTypeOf<Extract<Source, { type: 'file' }>['data']['url']>().toBeString()
  })
})
