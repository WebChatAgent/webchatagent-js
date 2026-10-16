/**
 * Terminal chat with streaming.
 *
 *   npm run build
 *   WEBCHATAGENT_CHATBOT_ID=<your-chatbot-id> node examples/node.ts            # interactive
 *   WEBCHATAGENT_CHATBOT_ID=<your-chatbot-id> node examples/node.ts "Hello"    # one question
 *
 * Optional: WEBCHATAGENT_BASE_URL for white-label or local servers.
 * Node 22.18+ runs this TypeScript file directly.
 */
import { createInterface } from 'node:readline/promises'
import { WebChatAgent, WebChatAgentError } from 'webchatagent'

const chatbotId = process.env['WEBCHATAGENT_CHATBOT_ID']
if (!chatbotId) {
  console.error('Set WEBCHATAGENT_CHATBOT_ID to your chatbot ID.')
  process.exit(1)
}

const chat = new WebChatAgent({ chatbotId, baseUrl: process.env['WEBCHATAGENT_BASE_URL'] })

async function ask(question: string): Promise<void> {
  try {
    for await (const event of chat.stream(question)) {
      if (event.type === 'text') process.stdout.write(event.delta)
      if (event.type === 'done') {
        const { reply } = event
        if (reply.mode === 'human') console.log(`\n[a team member takes over, live chat ${reply.status ?? 'waiting'}]`)
        if (reply.text) console.log(`\n\n${reply.text}`)
        for (const source of reply.sources) console.log(`  source: ${source.source}`)
        for (const suggestion of reply.suggestions) console.log(`  suggestion: ${suggestion.label}`)
      }
    }
  } catch (error) {
    if (!(error instanceof WebChatAgentError)) throw error
    console.error(`\nError ${error.status} (${error.code}): ${error.message}`)
  }
}

const config = await chat.getConfig()
const welcome = (config.widget.welcomeMessage ?? '').replace(/<[^>]*>/g, '') // HTML from the dashboard
console.log(`${config.widget.title ?? 'Chat'}: ${welcome}`)
console.log(`session ${chat.sessionId}`)

const once = process.argv[2]
if (once) {
  await ask(once)
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  for (;;) {
    const question = (await terminal.question('\n> ')).trim()
    if (!question || question === '/exit') break
    await ask(question)
  }
  terminal.close()
}
