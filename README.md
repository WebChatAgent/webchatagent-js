<p align="center">
  <a href="https://webchatagent.com"><img src="https://raw.githubusercontent.com/WebChatAgent/.github/main/profile/logo.png" width="88" alt="WebChatAgent"></a>
</p>

<h1 align="center">webchatagent</h1>

<p align="center">
  <b>Build your own AI chat in minutes, powered by your WebChatAgent chatbot.</b><br>
  Streaming answers with sources, file upload, lead forms and live handover to your team.<br>
  One typed package. Zero dependencies. Your design.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/webchatagent"><img src="https://img.shields.io/npm/v/webchatagent?color=4f46e5&label=npm" alt="npm version"></a>
  <a href="https://github.com/WebChatAgent/webchatagent-js/actions/workflows/ci.yml"><img src="https://github.com/WebChatAgent/webchatagent-js/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/types-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/dependencies-0-16a34a" alt="zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748b" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://webchatagent.com/register"><b>Create your chatbot</b></a> ·
  <a href="https://docs.webchatagent.com/developer-guide/javascript-sdk">Docs</a> ·
  <a href="examples/browser.html">Demo source</a> ·
  <a href="https://webchatagent.com/chatbot-api-integration">Chatbot API</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/WebChatAgent/webchatagent-js/main/.github/assets/demo.png" width="760" alt="A custom chat UI built with webchatagent: streamed answer, follow-up suggestions, AI label, feedback and handover button">
  <br><sub>A complete chat in one HTML file with this package, no framework: <a href="examples/browser.html">examples/browser.html</a></sub>
</p>

---

## Why webchatagent?

Your chatbot already knows your website, PDFs and help articles. It books appointments, searches products and hands tough questions to your team. This package puts all of that behind a few typed function calls, so you can ship it in **your** interface instead of a widget.

<table>
  <tr>
    <td width="50%" valign="top"><h3>⚡ Streaming in five lines</h3>Answers appear word by word, already cleaned for display. Stop button included.</td>
    <td width="50%" valign="top"><h3>🧑‍💼 Human handover built in</h3>When the bot hands over, your team answers live. Reconnects and missed messages are handled for you.</td>
  </tr>
  <tr>
    <td valign="top"><h3>📎 Files, leads, feedback</h3>Visitors send invoices or photos, fill your lead forms, rate answers. Everything lands in your dashboard.</td>
    <td valign="top"><h3>🔗 Sources and follow-ups</h3>Every answer comes with the pages it used and suggested next questions.</td>
  </tr>
  <tr>
    <td valign="top"><h3>🧩 Works everywhere</h3>React, Vue, Svelte, plain HTML, Node.js, Bun, Deno. ESM, strict TypeScript types, no dependencies.</td>
    <td valign="top"><h3>🤖 Ready for AI coding agents</h3>Claude Code, Cursor or Copilot get <a href="#for-ai-coding-agents">rules and a skeleton</a> to build your chat right.</td>
  </tr>
</table>

## Start in 30 seconds

**1.** [Create a chatbot](https://webchatagent.com/register) and point it at your website. 14-day free trial, no credit card.

**2.** Install the package:

```sh
npm install webchatagent
```

**3.** Talk to your bot:

```ts
import { WebChatAgent } from 'webchatagent'

const chat = new WebChatAgent({ chatbotId: 'YOUR-CHATBOT-ID', storage: localStorage })

for await (const event of chat.stream('Do you ship to Austria?')) {
  if (event.type === 'text') bubble.innerHTML = render(event.text) // Markdown, streamed
  if (event.type === 'done') showSuggestions(event.reply.suggestions)
}
```

That's it. Same knowledge, tools and settings as your website widget, in your own UI.

## What you can build

- **In-app support** in your SaaS, styled like the rest of your product, with handover to your support team
- **A help center search box** that answers in full sentences and links the source pages
- **Shop assistants** that find products and collect leads in your own checkout flow
- **Kiosk, POS or internal tools** where a floating widget doesn't fit
- **Server-side bridges** from Node.js, for example a Slack or Discord bot that asks your chatbot

> Only need a chat bubble on your website? The [embed code](https://docs.webchatagent.com/developer-guide/widget-embed) is even quicker. Use this package when you want full control over the interface.

## Guide

- [Install](#install)
- [Quick start](#quick-start)
- [Streaming](#streaming)
- [Conversations (sessions)](#conversations-sessions)
- [Rendering answers](#rendering-answers)
- [Chatbot settings](#chatbot-settings)
- [File upload](#file-upload)
- [Feedback](#feedback)
- [Lead forms](#lead-forms)
- [Human handover and live chat](#human-handover-and-live-chat)
- [Errors and limits](#errors-and-limits)
- [Your obligations](#your-obligations)
- [Security](#security)
- [Recipes: React, Vue/Nuxt, vanilla JS, Node.js](#recipes)
- [API reference](#api-reference)
- [For AI coding agents](#for-ai-coding-agents)
- [Compatibility](#compatibility)

## Install

```sh
npm install webchatagent
```

Without a build step, import it from a CDN:

```html
<script type="module">
  import { WebChatAgent } from 'https://cdn.jsdelivr.net/npm/webchatagent@1/dist/index.js'
</script>
```

You need the **chatbot ID**: in the [dashboard](https://webchatagent.com/dashboard) open your chatbot, then **Chatbot actions → Copy chatbot ID**. It looks like `3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c`.

## Quick start

```ts
import { WebChatAgent } from 'webchatagent'

const chat = new WebChatAgent({ chatbotId: 'YOUR-CHATBOT-ID' })

const reply = await chat.send('What are your opening hours?')
console.log(reply.text) // Markdown
```

Every following `send()` on the same instance continues the conversation, so the bot remembers what was said.

In the browser the API only answers pages on the chatbot's **allowed websites** (dashboard → **Settings → Name & Access**), if you set any. `localhost` always works for development. Open your page via `http://localhost`, not `file://` and not `127.0.0.1`.

## Streaming

`stream()` yields the answer while it is being written. Render `event.text`: it always holds the full answer so far, cleaned so half-written links or formatting never flash up.

```ts
for await (const event of chat.stream('Which plan fits a small shop?')) {
  switch (event.type) {
    case 'text':
      bubble.innerHTML = render(event.text) // full text so far; event.delta = just the new part
      break
    case 'error':
      console.warn(event.message) // the server recovered, the stream continues
      break
    case 'done':
      bubble.innerHTML = render(event.reply.text) // final answer, may differ slightly (e.g. renumbered citations)
      showSuggestions(event.reply.suggestions)
      break
  }
}
```

The last event is always `done` with the same `ChatReply` that `send()` returns. If the chatbot has streaming switched off, you get just the `done` event, so the same code works either way.

**Stop an answer:** pass an `AbortSignal`, or `break` out of the loop. Both stop the generation on the server.

```ts
const controller = new AbortController()
stopButton.onclick = () => controller.abort()

try {
  for await (const event of chat.stream(question, { signal: controller.signal })) { /* … */ }
} catch (error) {
  if ((error as Error).name !== 'AbortError') throw error
}
```

## Conversations (sessions)

A conversation is identified by `chat.sessionId`, a random UUID the client creates. To keep the conversation across page loads, pass a storage:

```ts
const chat = new WebChatAgent({ chatbotId: 'YOUR-CHATBOT-ID', storage: localStorage })

const earlier = await chat.history() // messages of this conversation, oldest first
chat.reset() // start a new conversation
```

- The ID is stored under `webchatagent:session:<chatbotId>`. Storage errors (private mode, blocked cookies) are ignored and the ID lives in memory.
- Storage is read only when the ID is first needed, so you can wait for consent before calling the API.
- To restore a conversation yourself, pass `sessionId` (must be a UUID).
- Conversations without activity for 30 days are deleted; `history()` then returns `[]`.
- When `reply.conversationTooLong` is `true` the conversation hit its length limit: call `reset()`.

`history()` returns `HistoryMessage[]` with `role` `'user'`, `'assistant'` (AI), `'agent'` (human team member) or `'system'` (see `event`: `'agent_joined'`, `'ended'`, `'timeout'`). Uploaded files are in `file`; their `text` is empty. Live chat messages have the same `role`, `text`, `file` and `event` fields.

## Rendering answers

`text` is Markdown. The package does not include a Markdown renderer; use any and **sanitize the HTML**, because answers can quote content from your website:

```ts
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const render = (markdown: string) => DOMPurify.sanitize(marked.parse(markdown, { async: false }))
```

Each `ChatReply` also has:

| Field | Use |
|---|---|
| `suggestions` | Follow-up questions. Show `label` on a button, send `text` when clicked. |
| `sources` | Where the answer came from. `type: 'web'` → `source` is a URL. Also `product`, `fileSource` (document), `file` (upload). |
| `aiGenerated` | `true` when the AI wrote the text. Label these answers (see [obligations](#your-obligations)). |
| `mode`, `status` | `mode: 'human'` → a team member took over, see [live chat](#human-handover-and-live-chat). |
| `id` | Pass the reply to `feedback()`. |

## Chatbot settings

`getConfig()` returns what you configured in the dashboard plus the features that are available, computed the same way the server checks them.

```ts
const config = await chat.getConfig()

config.widget.title            // 'Shop Assistant'
config.widget.welcomeMessage   // greeting to show first, HTML: sanitize before inserting
config.widget.promptButtons    // [{ title, action }] starter questions: show title, send action
config.widget.avatarSrc        // avatar URL ('' when none)
config.widget.themeColor       // and other colors
config.widget.privacyPolicyHtml
config.features                // { fileUpload, feedback, liveChat, askName, askEmail }
config.forms                   // lead forms you can submit right now
config.branding                // { required, text, url }
config.archived                // true → do not show the chat
```

Texts are translated automatically on paid plans; set `language` in the constructor to pick the language (default: the browser's).

## File upload

Visitors can send images, PDF, TXT, CSV, DOCX, XLS and XLSX files (max 2 MB) for the bot to read. Requires `config.features.fileUpload` (Premium and above).

```ts
const attachment = await chat.upload(fileInput.files[0])
const reply = await chat.send('What is the total on this invoice?', { attachment })
// the message may be empty when an attachment is sent
```

`reply.attachmentTruncated` tells you the file was long and only its beginning was read. Too large or wrong type → `WebChatAgentError` with `code` `'FILE_TOO_LARGE'` or `'UNSUPPORTED_TYPE'`.

## Feedback

Let visitors rate answers. Requires `config.features.feedback` (feedback function switched on in the dashboard). Rating the same answer again replaces the rating.

```ts
await chat.feedback(reply, 'up') // or 'down'; also accepts a HistoryMessage
```

## Lead forms

Forms you built in the dashboard (Action Bar) are in `config.forms`. Values are keyed by field ID. The client checks required fields and e-mail format before sending.

```ts
const [form] = config.forms
// form.fields: [{ id, type, label, required, placeholder?, options? }]
// type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox' | 'number' | 'info' (display-only text)

try {
  await chat.submitForm(form, { [nameField.id]: 'Jane Doe', [emailField.id]: 'jane@example.com' })
  showNotice(form.successMessage ?? 'Thank you!')
} catch (error) {
  if (error instanceof WebChatAgentError && error.code === 'INVALID_INPUT') {
    const { missing, invalid } = error.body as { missing: string[]; invalid: string[] } // field IDs
    highlight([...missing, ...invalid])
  }
}
```

The lead appears in the dashboard under Leads and, if switched on, triggers your lead notification.

## Human handover and live chat

A team member can take over a conversation in the dashboard's live chat. Requires `config.features.liveChat`.

**1. Handover starts** in one of two ways:

```ts
// The visitor asks for a person (shown as a button in your UI)
const result = await chat.requestHuman({ name: 'Jane', email: 'jane@example.com', reason: 'Order 1234' })
if (!result.ok) showNotice('No live chat available right now.') // result.reason: 'tool_inactive' | 'plan_not_supported'

// …or the bot hands over by itself: a reply comes back with mode 'human'
if (reply.mode === 'human') openLiveChat()
```

`name` is required when `config.features.askName` is true, `email` when `askEmail` is true.

**2. Connect** to receive the team member's messages in real time:

```ts
function openLiveChat() {
  const live = chat.liveChat() // returns the existing connection if one is active

  live.on('status', ({ status }) => setStatus(status)) // 'waiting' → 'open' → 'closed'
  live.on('message', (message) => {
    if (message.role === 'user') return // your own messages, already shown when sent
    if (message.role === 'system') return showNotice(message.event) // 'agent_joined' | 'ended' | 'timeout'
    showAgentMessage(message.text, message.file) // role 'agent'
  })
  live.on('typing', (isTyping) => setAgentTyping(isTyping))
  live.on('ended', ({ reason }) => backToBot()) // 'user_closed' | 'admin_closed' | 'already_closed' | 'closed'
  live.on('disconnected', () => setStatus('reconnecting'))
  live.on('ready', () => setStatus(live.status)) // connected again
  return live
}
```

The connection sends a small ping every 45 s so proxies keep it open, and reconnects by itself (3 s, then up to 30 s apart). Messages the team member sent while the visitor was offline arrive as `message` events after the reconnect, so you never need to merge `history()` yourself.

**3. Talk** while `live.canSend` is true (status `waiting` or `open`). Messages go through the live chat, not `send()`:

```ts
if (live.canSend) {
  showOwnMessage(text) // render immediately
  await live.send(text) // resolves when the server confirmed it
}
input.oninput = () => live.typing(true) // call on every keystroke, only changes are sent
await live.upload(file) // max 5 MB, also archives and office files
```

**4. End** the live chat. Afterwards the bot answers again via `send()`.

```ts
await live.end() // visitor ends it for both sides
live.close() // only disconnect, e.g. when your component unmounts
```

**After a page reload**, resume a running live chat:

```ts
const state = await chat.liveChatStatus() // { status, mode } | null
if (state && state.status !== 'closed') openLiveChat()
```

Messages from a team member are translated into the visitor's `language` when translation is on.

## Errors and limits

Every failure is a `WebChatAgentError` (except `AbortError` from your own signal). `message` is plain text you can show to visitors.

```ts
import { WebChatAgentError } from 'webchatagent'

try {
  await chat.send(text)
} catch (error) {
  if (!(error instanceof WebChatAgentError)) throw error
  error.code    // 'NETWORK' | 'INVALID_INPUT' | 'HTTP' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'STREAM_INTERRUPTED' | 'LIVE_CHAT_INACTIVE' | 'TIMEOUT'
  error.status  // HTTP status, 0 without response
  error.message // e.g. "The chat is temporarily unavailable. Please try again later."
}
```

| Status | Meaning |
|---|---|
| 400 | Invalid request, e.g. unknown chatbot ID format |
| 403 | Page not on the allowed websites, or blocked |
| 404 | Chatbot not found |
| 410 | Conversation expired (handled by `history()`) |
| 429 | Too many messages, or the chat is unavailable right now. Try again later. |
| 5xx | Temporary server or AI provider problem |

Limits:

- Messages: max `MAX_MESSAGE_LENGTH` (700) characters, checked before sending.
- Rate: 10 messages per minute per conversation, 15 per minute per IP address, and at least 1 second between two messages from the same conversation or IP address. The client does not retry automatically.
- Uploads: 2 MB to the bot, 5 MB in live chat.

## Your obligations

When you build your own UI, a few things the widget does for you are your job:

1. **Branding:** if `config.branding.required` is `true`, show `config.branding.text` linked to `config.branding.url` in your chat (e.g. small text below the input). Plans that may remove it return `false`.
2. **AI label:** mark answers with `aiGenerated: true` as AI-generated (EU AI Act, Article 50).
3. **Privacy notice:** show `config.widget.privacyPolicyHtml` (sanitized) before or below the chat.

## Security

- **Treat `sessionId` like a password.** Anyone with the chatbot ID and the session ID can read that conversation. Use the generated random UUIDs, never derive them from user data, and do not put them in URLs or logs.
- **One session per chatbot.** The conversation memory is tied to the session ID; reusing it across chatbots mixes their conversations.
- **Allowed websites are not access control.** They stop other websites from embedding your bot in browsers, but any server can call the API. Never give the bot knowledge that must stay private.
- **Sanitize** rendered Markdown and `privacyPolicyHtml` (see [Rendering answers](#rendering-answers)).

## Recipes

### React

```tsx
import { useMemo, useState } from 'react'
import { WebChatAgent, type ChatReply } from 'webchatagent'

type Message = { role: 'user' | 'assistant'; text: string; reply?: ChatReply }

export function useChat(chatbotId: string) {
  const chat = useMemo(() => new WebChatAgent({ chatbotId, storage: localStorage }), [chatbotId])
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)

  async function send(text: string) {
    setBusy(true)
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])
    const update = (patch: Partial<Message>) => setMessages((m) => [...m.slice(0, -1), { ...m[m.length - 1]!, ...patch }])
    try {
      for await (const event of chat.stream(text)) {
        if (event.type === 'text') update({ text: event.text })
        if (event.type === 'done') update({ text: event.reply.text, reply: event.reply })
      }
    } catch (error) {
      update({ text: error instanceof Error ? error.message : 'Something went wrong.' })
    } finally {
      setBusy(false)
    }
  }

  return { messages, send, busy, chat }
}
```

### Vue 3 / Nuxt

```ts
// composables/useChat.ts
import { ref, shallowRef } from 'vue'
import { WebChatAgent, type ChatReply } from 'webchatagent'

export function useChat(chatbotId: string) {
  // Nuxt: create the client in the browser only (onMounted or <ClientOnly>), localStorage does not exist on the server.
  const chat = shallowRef(new WebChatAgent({ chatbotId, storage: localStorage }))
  const messages = ref<{ role: 'user' | 'assistant'; text: string; reply?: ChatReply }[]>([])
  const busy = ref(false)

  async function send(text: string) {
    busy.value = true
    messages.value.push({ role: 'user', text })
    const answer = ref({ role: 'assistant' as const, text: '', reply: undefined as ChatReply | undefined })
    messages.value.push(answer.value)
    try {
      for await (const event of chat.value.stream(text)) {
        if (event.type === 'text') answer.value.text = event.text
        if (event.type === 'done') Object.assign(answer.value, { text: event.reply.text, reply: event.reply })
      }
    } finally {
      busy.value = false
    }
  }

  return { messages, send, busy, chat }
}
```

### Vanilla JS

[`examples/browser.html`](examples/browser.html) is a complete chat page without a framework: streaming, stop button, suggestions, sources, upload, feedback, lead forms, human handover, live chat, branding and privacy notice. Run it with `npm run build && npx serve .` and open `http://localhost:3000/examples/browser.html?chatbotId=YOUR-CHATBOT-ID`.

### Node.js

[`examples/node.ts`](examples/node.ts) is a terminal chat with streaming.

```ts
import { WebChatAgent } from 'webchatagent'

const chat = new WebChatAgent({ chatbotId: process.env.WEBCHATAGENT_CHATBOT_ID!, language: 'en' })
for await (const event of chat.stream('Summarize your return policy')) {
  if (event.type === 'text') process.stdout.write(event.delta)
}
```

Server-side, all your users share your server's IP address, so the per-IP rate limit (15 per minute, 1 per second) applies to all of them together. For chats with many visitors, call the API from the browser.

### White-label

Partners with their own domain pass it as `baseUrl`:

```ts
const chat = new WebChatAgent({ chatbotId, baseUrl: 'https://chat.your-agency.com' })
```

## API reference

### `new WebChatAgent(options)`

| Option | Type | Default | |
|---|---|---|---|
| `chatbotId` | `string` | required | UUID from the dashboard |
| `baseUrl` | `string` | `https://webchatagent.com` | API origin (white-label domain) |
| `sessionId` | `string` | from `storage` or new | Continue a conversation (UUID) |
| `storage` | `StorageLike` | none | e.g. `localStorage` |
| `language` | `string` | browser language | e.g. `'de'`, `'en-US'` |
| `fetch` | `FetchLike` | `globalThis.fetch` | for tests or proxies |
| `WebSocket` | `WebSocketConstructorLike` | `globalThis.WebSocket` | for live chat |

### `WebChatAgent`

| Member | Returns | |
|---|---|---|
| `send(message, options?)` | `Promise<ChatReply>` | Complete answer |
| `stream(message, options?)` | `AsyncGenerator<ChatStreamEvent>` | `text`, `error`, `done` |
| `history()` | `Promise<HistoryMessage[]>` | Messages of the conversation |
| `getConfig()` | `Promise<ChatbotConfig>` | Settings, features, forms, branding |
| `upload(file, name?)` | `Promise<UploadedFile>` | Then `send(text, { attachment })` |
| `feedback(message, 'up' \| 'down')` | `Promise<void>` | Rate an answer |
| `submitForm(form, values)` | `Promise<void>` | Submit a lead form |
| `requestHuman(options?)` | `Promise<RequestHumanResult>` | Ask for a team member |
| `liveChatStatus()` | `Promise<{ status, mode } \| null>` | Resume after reload |
| `liveChat()` | `LiveChat` | Real-time connection |
| `reset()` | `void` | New conversation |
| `sessionId` | `string` | Current conversation ID |
| `chatbotId`, `baseUrl` | `string` | |

`SendOptions`: `pageUrl` (default in browsers: `location.href`, helps with page-specific questions), `contextData` (facts about the visitor, e.g. `{ plan: 'pro', customerId: 42 }`, max 20 keys), `attachment`, `signal`.

### `LiveChat`

| Member | |
|---|---|
| `on(event, listener)` | Events: `ready`, `message`, `status`, `typing`, `ended`, `disconnected`. Returns an unsubscribe function. |
| `send(text)` | `Promise<LiveChatMessage>`, resolves when the server confirmed |
| `canSend` | `true` while a handover is waiting or open |
| `typing(isTyping)` | Typing indicator for the team member |
| `upload(file, name?)` | `Promise<UploadedFile>` |
| `end()` | End the live chat for both sides |
| `close()` | Disconnect only |
| `status`, `ready`, `active` | Current state |

All types (`ChatReply`, `ChatStreamEvent`, `Source`, `HistoryMessage`, `LiveChatMessage`, `ChatbotConfig`, `Form`, …) are exported and documented in the type definitions.

## For AI coding agents

Rules for generating code with this package:

1. `import { WebChatAgent, WebChatAgentError } from 'webchatagent'`. ESM only. Ask the user for the chatbot ID (a UUID) instead of inventing one.
2. Create **one** client per chatbot and conversation and reuse it. In browsers pass `storage: localStorage`. In SSR frameworks create it on the client only.
3. Prefer `stream()` for UIs: render `event.text` on `text` events (full text, not a delta), replace it with `event.reply.text` on `done`.
4. `text` is Markdown: render it with a Markdown library and sanitize the HTML (DOMPurify). `config.widget.welcomeMessage` and `privacyPolicyHtml` are HTML: sanitize them too. Never insert unsanitized content.
5. Show `reply.suggestions` as buttons (`label` shown, `text` sent). Show `config.widget.promptButtons` (`title` shown, `action` sent) before the first message.
6. If `reply.mode === 'human'`, open `chat.liveChat()` and send further messages with `live.send()` while `live.canSend` is true, until the `ended` event. On load, call `chat.liveChatStatus()` and reconnect if `status` is `waiting` or `open`. Do not refetch history on reconnect: missed messages arrive as `message` events.
7. Gate optional UI on `config.features` (`fileUpload`, `feedback`, `liveChat`) and `config.forms`.
8. Always: show `config.branding` when `required`, label AI answers (`reply.aiGenerated`), show `config.widget.privacyPolicyHtml`.
9. Catch `WebChatAgentError` and show `error.message`. Rethrow other errors. Do not retry 429 in a loop.
10. Keep messages ≤ `MAX_MESSAGE_LENGTH`. Never log or expose `chat.sessionId`.

Minimal skeleton:

```ts
import { WebChatAgent, WebChatAgentError } from 'webchatagent'

const chat = new WebChatAgent({ chatbotId: CHATBOT_ID, storage: localStorage })
const config = await chat.getConfig()

async function ask(question: string, onText: (markdown: string) => void) {
  try {
    for await (const event of chat.stream(question)) {
      if (event.type === 'text') onText(event.text)
      if (event.type === 'done') {
        onText(event.reply.text)
        if (event.reply.mode === 'human') chat.liveChat()
        return event.reply
      }
    }
  } catch (error) {
    if (error instanceof WebChatAgentError) onText(error.message)
    else throw error
  }
}
```

The REST endpoints behind this package are documented at [docs.webchatagent.com](https://docs.webchatagent.com/developer-guide/rest-api).

## Compatibility

- Browsers with ES2022 (Chrome/Edge 94+, Firefox 93+, Safari 16.4+)
- Node.js 22.12+ (`fetch`, `WebSocket` built in). Older runtimes: pass `fetch` and `WebSocket` (e.g. the `ws` package).
- Bun and Deno
- ESM only. CommonJS projects can `require('webchatagent')` on Node.js 22.12+; TypeScript users need TypeScript 5.8+ for that.
- TypeScript 5.0+ for the type definitions

## Support

Questions and bugs: [GitHub issues](https://github.com/WebChatAgent/webchatagent-js/issues) or support@webchatagent.com. Documentation: [docs.webchatagent.com](https://docs.webchatagent.com).

## License

[MIT](LICENSE)

---

<p align="center">
  <a href="https://webchatagent.com"><img src="https://raw.githubusercontent.com/WebChatAgent/.github/main/profile/logo.png" width="40" alt="WebChatAgent"></a><br>
  <b><a href="https://webchatagent.com">WebChatAgent</a></b>: AI chatbot and phone assistant for business websites. Hosted in Germany.<br>
  <a href="https://webchatagent.com/register">Start free</a> · <a href="https://webchatagent.com/pricing">Pricing</a> · <a href="https://docs.webchatagent.com">Docs</a> · <a href="https://github.com/WebChatAgent">More integrations</a>
</p>
