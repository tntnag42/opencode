// A deterministic stand-in for an OpenAI-compatible (chat completions) and Anthropic-compatible (messages) LLM API.
// Each test scripts the assistant turns it wants; the server replays them in order as streamed responses and records
// every request it receives so tests can assert on what opencode sent.

export type ToolCall = { name: string; input: Record<string, unknown>; id?: string }

export type Turn = {
  text?: string
  reasoning?: string
  toolCalls?: ToolCall[]
  /** Respond with this HTTP error instead of a stream. */
  error?: { status: number; body?: unknown }
  /** Delay before the first byte, in milliseconds. */
  delayMs?: number
  /** Stream the text in chunks this many milliseconds apart (default: one chunk, no delay). */
  chunkDelayMs?: number
  /** Keep the stream open without finishing it until the client disconnects. */
  hang?: boolean
  usage?: { input: number; output: number }
}

export type Script = Turn[] | ((request: RecordedRequest, index: number) => Turn)

export type Message = { role: string; content: string; toolCallID?: string; toolCalls?: ToolCall[] }

export type RecordedRequest = {
  api: "openai" | "anthropic"
  path: string
  headers: Record<string, string>
  body: any
  model: string
  system: string
  messages: Message[]
  tools: string[]
  kind: "title" | "agent"
}

const TITLE_MARKER = "You name conversations"

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: any) => {
      if (typeof part === "string") return part
      if (part.type === "text") return part.text
      if (part.type === "tool_result") return textOf(part.content)
      return ""
    })
    .join("")
}

function normalizeOpenAI(body: any): Pick<RecordedRequest, "system" | "messages" | "tools"> {
  const messages: Message[] = (body.messages ?? []).map((m: any) => ({
    role: m.role,
    content: textOf(m.content),
    toolCallID: m.tool_call_id,
    toolCalls: m.tool_calls?.map((c: any) => ({
      id: c.id,
      name: c.function.name,
      input: JSON.parse(c.function.arguments || "{}"),
    })),
  }))
  return {
    system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
    messages: messages.filter((m) => m.role !== "system"),
    tools: (body.tools ?? []).map((t: any) => t.function?.name ?? t.name),
  }
}

function normalizeAnthropic(body: any): Pick<RecordedRequest, "system" | "messages" | "tools"> {
  const messages: Message[] = (body.messages ?? []).flatMap((m: any): Message[] => {
    if (!Array.isArray(m.content)) return [{ role: m.role, content: textOf(m.content) }]
    const results = m.content
      .filter((p: any) => p.type === "tool_result")
      .map((p: any) => ({ role: "tool", content: textOf(p.content), toolCallID: p.tool_use_id }))
    const calls = m.content
      .filter((p: any) => p.type === "tool_use")
      .map((p: any) => ({ id: p.id, name: p.name, input: p.input }))
    const text = m.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("")
    const own = text || calls.length || !results.length ? [{ role: m.role, content: text, toolCalls: calls.length ? calls : undefined }] : []
    return [...results, ...own]
  })
  return {
    system: textOf(body.system),
    messages,
    tools: (body.tools ?? []).map((t: any) => t.name),
  }
}

const sse = (data: unknown, event?: string) => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function stream(chunks: (string | number)[], hang: boolean, signal: AbortSignal) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (signal.aborted) return
        if (typeof chunk === "number") await sleep(chunk)
        else controller.enqueue(encoder.encode(chunk))
      }
      if (hang) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        return
      }
      controller.close()
    },
  })
}

function chunkText(text: string, delay: number | undefined) {
  if (!delay) return [text]
  return text.match(/.{1,8}/gs) ?? [text]
}

function openaiStream(turn: Turn, model: string, callBase: number) {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model }
  const delta = (d: unknown, finish: string | null = null, extra = {}) =>
    sse({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra })
  const out: (string | number)[] = [delta({ role: "assistant", content: "" })]
  if (turn.reasoning) out.push(delta({ reasoning_content: turn.reasoning }))
  for (const piece of turn.text ? chunkText(turn.text, turn.chunkDelayMs) : []) {
    if (turn.chunkDelayMs) out.push(turn.chunkDelayMs)
    out.push(delta({ content: piece }))
  }
  ;(turn.toolCalls ?? []).forEach((call, index) => {
    out.push(
      delta({
        tool_calls: [
          {
            index,
            id: call.id ?? `call_${callBase + index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      }),
    )
  })
  if (turn.hang) return out
  const usage = turn.usage ?? { input: 10, output: 5 }
  out.push(
    delta({}, turn.toolCalls?.length ? "tool_calls" : "stop", {
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    }),
  )
  out.push("data: [DONE]\n\n")
  return out
}

function anthropicStream(turn: Turn, model: string, callBase: number) {
  const usage = turn.usage ?? { input: 10, output: 5 }
  const out: (string | number)[] = [
    sse(
      {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input, output_tokens: 0 },
        },
      },
      "message_start",
    ),
  ]
  let index = 0
  if (turn.text) {
    out.push(sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, "content_block_start"))
    for (const piece of chunkText(turn.text, turn.chunkDelayMs)) {
      if (turn.chunkDelayMs) out.push(turn.chunkDelayMs)
      out.push(sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }, "content_block_delta"))
    }
    out.push(sse({ type: "content_block_stop", index }, "content_block_stop"))
    index++
  }
  ;(turn.toolCalls ?? []).forEach((call, i) => {
    out.push(
      sse(
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: call.id ?? `toolu_${callBase + i}`, name: call.name, input: {} },
        },
        "content_block_start",
      ),
    )
    out.push(
      sse(
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } },
        "content_block_delta",
      ),
    )
    out.push(sse({ type: "content_block_stop", index }, "content_block_stop"))
    index++
  })
  if (turn.hang) return out
  out.push(
    sse(
      {
        type: "message_delta",
        delta: { stop_reason: turn.toolCalls?.length ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.output },
      },
      "message_delta",
    ),
  )
  out.push(sse({ type: "message_stop" }, "message_stop"))
  return out
}

export type MockProvider = Awaited<ReturnType<typeof startMockProvider>>

export async function startMockProvider(options: { script?: Script; title?: string } = {}) {
  let script: Script = options.script ?? []
  const requests: RecordedRequest[] = []
  const titleRequests: RecordedRequest[] = []
  const unexpected: RecordedRequest[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  let calls = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] })
      const api = url.pathname.endsWith("/chat/completions")
        ? "openai"
        : url.pathname.endsWith("/messages")
          ? "anthropic"
          : undefined
      if (!api || request.method !== "POST") return new Response("not found", { status: 404 })
      const body: any = await request.json()
      const normalized = api === "openai" ? normalizeOpenAI(body) : normalizeAnthropic(body)
      const recorded: RecordedRequest = {
        api,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body,
        model: body.model,
        ...normalized,
        kind: normalized.system.includes(TITLE_MARKER) ? "title" : "agent",
      }
      let turn: Turn
      if (recorded.kind === "title") {
        titleRequests.push(recorded)
        turn = { text: options.title ?? "Mock session title" }
      } else {
        const index = requests.length
        requests.push(recorded)
        const next = typeof script === "function" ? script(recorded, index) : script[index]
        if (!next) unexpected.push(recorded)
        turn = next ?? { text: "[mock] script exhausted" }
        for (const waiter of waiters.filter((w) => requests.length >= w.count)) {
          waiter.resolve()
          waiters.splice(waiters.indexOf(waiter), 1)
        }
      }
      if (turn.delayMs) await sleep(turn.delayMs)
      if (turn.error)
        return Response.json(turn.error.body ?? { error: { message: "mock error", type: "mock_error" } }, {
          status: turn.error.status,
        })
      const callBase = calls
      calls += turn.toolCalls?.length ?? 0
      const chunks = api === "openai" ? openaiStream(turn, recorded.model, callBase) : anthropicStream(turn, recorded.model, callBase)
      return new Response(stream(chunks, !!turn.hang, request.signal), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })

  return {
    url: server.url.toString().replace(/\/$/, ""),
    requests,
    titleRequests,
    unexpected,
    setScript(next: Script) {
      script = next
    },
    /** Resolves once at least `count` agent requests have arrived. */
    waitForRequests(count: number) {
      if (requests.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push({ count, resolve }))
    },
    /** Tool results opencode sent back in the given agent request (default: the last one). */
    toolResults(index = requests.length - 1) {
      return requests[index]?.messages.filter((m) => m.role === "tool") ?? []
    },
    lastUserMessage(index = requests.length - 1) {
      return requests[index]?.messages.findLast((m) => m.role === "user")?.content ?? ""
    },
    async stop() {
      await server.stop(true)
    },
    [Symbol.asyncDispose]() {
      return server.stop(true)
    },
  }
}
