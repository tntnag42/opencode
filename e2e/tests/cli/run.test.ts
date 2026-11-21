import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { startMockProvider } from "../../harness/mock-provider"
import { createWorkspace, parseJsonLines, run } from "../../harness/opencode"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

describe("opencode run", () => {
  test("prints the assistant reply and exits 0", async () => {
    await using mock = await startMockProvider({ script: [{ text: "Hello from the mock provider" }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["say hello"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Hello from the mock provider")
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0].model).toBe("m1")
    expect(mock.lastUserMessage()).toContain("say hello")
    expect(mock.unexpected).toHaveLength(0)
  })

  test("--format json emits one JSON event per line with text and usage", async () => {
    await using mock = await startMockProvider({ script: [{ text: "json mode reply", usage: { input: 42, output: 7 } }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["--format", "json", "hi"])
    expect(result.exitCode).toBe(0)
    const events = parseJsonLines(result.stdout)
    const types = events.map((e) => e.type)
    expect(types).toContain("step_start")
    expect(types).toContain("step_finish")
    const text = events.filter((e) => e.type === "text").map((e) => e.part.text).join("")
    expect(text).toBe("json mode reply")
    const finish = events.find((e) => e.type === "step_finish")
    expect(finish.part.tokens).toMatchObject({ input: 42, output: 7 })
    expect(new Set(events.map((e) => e.sessionID)).size).toBe(1)
    expect(events[0].sessionID).toMatch(/^ses_/)
  })

  test("joins multiple positional words into one message", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["first", "second", "third"])
    expect(result.exitCode).toBe(0)
    expect(mock.lastUserMessage()).toContain("first second third")
  })

  test("reads the message from stdin when no argument is given", async () => {
    await using mock = await startMockProvider({ script: [{ text: "got stdin" }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, [], { stdin: "message from stdin\n" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("got stdin")
    expect(mock.lastUserMessage()).toContain("message from stdin")
  })

  test("appends piped stdin to the positional message", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["summarize this:"], { stdin: "piped body" })
    expect(result.exitCode).toBe(0)
    expect(mock.lastUserMessage()).toContain("summarize this:\npiped body")
  })

  test("fails with exit 1 and no provider call when the message is empty", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, [], { stdin: "" })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("You must provide a message")
    expect(mock.requests).toHaveLength(0)
  })

  test("--model selects another configured model", async () => {
    await using mock = await startMockProvider({ script: [{ text: "from m2" }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["--model", "mock/m2", "hi"])
    expect(result.exitCode).toBe(0)
    expect(mock.requests[0].model).toBe("m2")
  })

  test("--model with an unknown model fails with a non-zero exit", async () => {
    await using mock = await startMockProvider({ script: [{ text: "should not be called" }] })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["--model", "mock/does-not-exist", "hi"])
    expect(result.exitCode).not.toBe(0)
    expect(mock.requests).toHaveLength(0)
  })

  test("--file attaches a text file to the prompt", async () => {
    await using mock = await startMockProvider({ script: [{ text: "seen" }] })
    await using ws = await createWorkspace({ mock })
    await ws.write("notes.txt", "the secret word is pineapple")
    const result = await run(ws, ["--file", "notes.txt", "what is the secret word?"])
    expect(result.exitCode).toBe(0)
    const user = mock.lastUserMessage()
    expect(user).toContain('<file name="notes.txt">')
    expect(user).toContain("the secret word is pineapple")
  })

  test("--file with a missing file fails before contacting the provider", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["--file", "missing.txt", "hi"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("File not found: missing.txt")
    expect(mock.requests).toHaveLength(0)
  })

  test("--continue resumes the previous session with its history", async () => {
    await using mock = await startMockProvider({ script: [{ text: "first answer" }, { text: "second answer" }] })
    await using ws = await createWorkspace({ mock })
    const first = await run(ws, ["--format", "json", "first question"])
    expect(first.exitCode).toBe(0)
    const second = await run(ws, ["--format", "json", "--continue", "second question"])
    expect(second.exitCode).toBe(0)
    expect(parseJsonLines(second.stdout)[0].sessionID).toBe(parseJsonLines(first.stdout)[0].sessionID)
    const history = mock.requests[1].messages.map((m) => m.content).join("\n")
    expect(history).toContain("first question")
    expect(history).toContain("first answer")
    expect(history).toContain("second question")
  })

  test("--session targets a specific session", async () => {
    await using mock = await startMockProvider({ script: [{ text: "a" }, { text: "b" }, { text: "c" }] })
    await using ws = await createWorkspace({ mock })
    const first = await run(ws, ["--format", "json", "session one"])
    const id = parseJsonLines(first.stdout)[0].sessionID
    await run(ws, ["--format", "json", "session two"])
    const third = await run(ws, ["--format", "json", "--session", id, "back to one"])
    expect(third.exitCode).toBe(0)
    expect(parseJsonLines(third.stdout)[0].sessionID).toBe(id)
    const history = mock.requests[2].messages.map((m) => m.content).join("\n")
    expect(history).toContain("session one")
    expect(history).not.toContain("session two")
  })

  test("--fork without --continue or --session is rejected", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["--fork", "hi"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("--fork requires --continue or --session")
  })

  test("a provider HTTP error surfaces as a failed run", async () => {
    await using mock = await startMockProvider({
      script: [{ error: { status: 400, body: { error: { message: "mock bad request", type: "invalid_request_error" } } } }],
    })
    await using ws = await createWorkspace({ mock })
    const result = await run(ws, ["--format", "json", "hi"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("mock bad request")
  })

  test("works against an Anthropic-compatible provider", async () => {
    await using mock = await startMockProvider({ script: [{ text: "anthropic says hi" }] })
    await using ws = await createWorkspace({ mock, provider: { api: "anthropic" } })
    const result = await run(ws, ["hello"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("anthropic says hi")
    expect(mock.requests[0].api).toBe("anthropic")
    expect(mock.requests[0].headers["x-api-key"]).toBe("mock-key")
  })

  test("sends the configured API key as a bearer token to OpenAI-compatible providers", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    await run(ws, ["hi"])
    expect(mock.requests[0].headers.authorization).toBe("Bearer mock-key")
  })
})
