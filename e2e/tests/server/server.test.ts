import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { startMockProvider, type Script } from "../../harness/mock-provider"
import { allowAll, createWorkspace, startServer, type Server, type Workspace } from "../../harness/opencode"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

const directTools = [...allowAll, { action: "execute", resource: "*", effect: "deny" }]

async function setup(script: Script = [], config: Record<string, unknown> = { permissions: directTools }) {
  const mock = await startMockProvider({ script })
  const ws = await createWorkspace({ mock, config })
  const server = await startServer(ws)
  return {
    mock,
    ws,
    server,
    async [Symbol.asyncDispose]() {
      await server.stop()
      await mock.stop()
      await ws[Symbol.asyncDispose]()
    },
  }
}

async function createSession(server: Server, ws: Workspace, body: Record<string, unknown> = {}) {
  const created = await server.api("POST", "/api/session", { location: { directory: ws.dir }, ...body })
  expect(created.status).toBe(200)
  return created.json.data as { id: string; title?: string; location: { directory: string } }
}

async function promptAndWait(server: Server, sessionID: string, text: string) {
  const prompt = await server.api("POST", `/api/session/${sessionID}/prompt`, { text })
  expect(prompt.status).toBe(200)
  const wait = await server.api("POST", `/api/experimental/session/${sessionID}/wait`)
  expect(wait.status).toBe(204)
  const messages = await server.api("GET", `/api/session/${sessionID}/message`)
  expect(messages.status).toBe(200)
  return messages.json.data as any[]
}

describe("opencode serve: basics", () => {
  test("requires basic auth with the configured password", async () => {
    await using env = await setup()
    const { server } = env
    expect((await fetch(server.url + "/api/info")).status).toBe(401)
    const wrong = await fetch(server.url + "/api/info", { headers: { authorization: "Basic " + btoa("opencode:wrong") } })
    expect(wrong.status).toBe(401)
    const wrongUser = await fetch(server.url + "/api/info", { headers: { authorization: "Basic " + btoa("admin:" + server.password) } })
    expect(wrongUser.status).toBe(401)
    const info = await server.api("GET", "/api/info")
    expect(info.status).toBe(200)
    expect(info.json).toMatchObject({ version: expect.any(String), pid: server.process.pid })
    expect(info.json.urls).toContain(server.url)
  })

  test("publishes an OpenAPI document covering the session API", async () => {
    await using env = await setup()
    const doc = await env.server.api("GET", "/openapi.json")
    expect(doc.status).toBe(200)
    const paths = Object.keys(doc.json.paths)
    expect(paths).toEqual(
      expect.arrayContaining(["/api/session", "/api/session/{sessionID}", "/api/session/{sessionID}/prompt", "/api/event"]),
    )
  })

  test("resolves the workspace location and eventually lists the configured provider and models", async () => {
    await using env = await setup()
    const { server, ws } = env
    const location = await server.api("GET", "/api/location")
    expect(location.status).toBe(200)
    expect(location.json.directory).toBe(ws.dir)
    const deadline = Date.now() + 20_000
    let models: any[] = []
    while (Date.now() < deadline) {
      models = (await server.api("GET", "/api/model")).json.data
      if (models.length) break
      await Bun.sleep(250)
    }
    expect(models.map((m) => `${m.providerID}/${m.id}`).sort()).toEqual(["mock/m1", "mock/m2"])
    const providers = await server.api("GET", "/api/provider")
    expect(providers.json.data.map((p: any) => p.id)).toEqual(["mock"])
    const fallback = await server.api("GET", "/api/model/default")
    expect(fallback.json.data).toMatchObject({ providerID: "mock", id: "m1" })
  })

  // Known issue: the first catalog request for a location returns empty lists (and a null default model) instead of
  // waiting for the catalog to load; the same requests succeed a moment later. Remove .failing once fixed.
  test.failing("lists the configured models on the very first request", async () => {
    await using env = await setup()
    const models = await env.server.api("GET", "/api/model")
    expect(models.json.data.length).toBeGreaterThan(0)
  })

  test("stops cleanly on SIGTERM", async () => {
    await using env = await setup()
    const code = await env.server.stop()
    expect(env.server.process.signalCode === "SIGTERM" || code === 0 || code === 143).toBe(true)
    await expect(fetch(env.server.url + "/api/info")).rejects.toThrow()
  })
})

describe("opencode serve: sessions", () => {
  test("create, get, list, update, and delete a session", async () => {
    await using env = await setup()
    const { server, ws } = env
    const session = await createSession(server, ws, { title: "e2e session" })
    expect(session.id).toMatch(/^ses_/)
    expect(session.title).toBe("e2e session")
    expect(session.location.directory).toBe(ws.dir)

    const got = await server.api("GET", `/api/session/${session.id}`)
    expect(got.status).toBe(200)
    expect(got.json.data.id).toBe(session.id)

    const list = await server.api("GET", "/api/session")
    expect(list.json.data.map((s: any) => s.id)).toContain(session.id)

    const update = await server.api("PATCH", `/api/session/${session.id}`, { title: "renamed" })
    expect(update.status).toBe(204)
    expect((await server.api("GET", `/api/session/${session.id}`)).json.data.title).toBe("renamed")

    const removed = await server.api("DELETE", `/api/session/${session.id}`)
    expect(removed.status).toBeLessThan(300)
    expect((await server.api("GET", `/api/session/${session.id}`)).status).toBe(404)
  })

  test("returns 404 for an unknown session", async () => {
    await using env = await setup()
    const missing = await env.server.api("GET", "/api/session/ses_doesnotexist")
    expect(missing.status).toBe(404)
    const prompt = await env.server.api("POST", "/api/session/ses_doesnotexist/prompt", { text: "hi" })
    expect(prompt.status).toBe(404)
  })

  test("rejects a malformed prompt body", async () => {
    await using env = await setup()
    const session = await createSession(env.server, env.ws)
    const bad = await env.server.api("POST", `/api/session/${session.id}/prompt`, { nottext: 1 })
    expect(bad.status).toBe(400)
    expect(env.mock.requests).toHaveLength(0)
  })

  test("a prompt runs the agent and the reply is stored as messages", async () => {
    await using env = await setup([{ text: "stored reply", usage: { input: 11, output: 4 } }])
    const { server, ws, mock } = env
    const session = await createSession(server, ws)
    const messages = await promptAndWait(server, session.id, "hello over http")
    expect(mock.lastUserMessage()).toContain("hello over http")
    const user = messages.find((m) => m.type === "user")
    expect(user.text).toBe("hello over http")
    const assistant = messages.find((m) => m.type === "assistant")
    expect(assistant).toMatchObject({ model: { id: "m1", providerID: "mock" }, finish: "stop", tokens: { input: 11, output: 4 } })
    expect(assistant.content).toEqual([{ type: "text", text: "stored reply" }])
    // Session usage also counts the title-generation call, which the mock bills at 10 input / 5 output tokens.
    expect(mock.titleRequests).toHaveLength(1)
    const after = await server.api("GET", `/api/session/${session.id}`)
    expect(after.json.data.tokens).toMatchObject({ input: 21, output: 9 })
    expect(after.json.data.title).toBe("Mock session title")
  })

  test("a second prompt includes the earlier conversation", async () => {
    await using env = await setup([{ text: "one" }, { text: "two" }])
    const { server, ws, mock } = env
    const session = await createSession(server, ws)
    await promptAndWait(server, session.id, "first")
    await promptAndWait(server, session.id, "second")
    const history = mock.requests[1].messages.map((m) => `${m.role}:${m.content}`)
    expect(history).toEqual(expect.arrayContaining([expect.stringContaining("user:first"), "assistant:one", expect.stringContaining("user:second")]))
  })

  test("session model can be chosen at creation", async () => {
    await using env = await setup([{ text: "from m2" }])
    const session = await createSession(env.server, env.ws, { model: { providerID: "mock", id: "m2" } })
    await promptAndWait(env.server, session.id, "hi")
    expect(env.mock.requests[0].model).toBe("m2")
  })

  test("fork copies the history into a new session", async () => {
    await using env = await setup([{ text: "original answer" }, { text: "forked answer" }])
    const { server, ws, mock } = env
    const session = await createSession(server, ws)
    await promptAndWait(server, session.id, "original question")
    const forked = await server.api("POST", `/api/session/${session.id}/fork`, {})
    expect(forked.status).toBe(200)
    const fork = forked.json.data
    expect(fork.id).not.toBe(session.id)
    const messages = await promptAndWait(server, fork.id, "follow up")
    expect(messages.some((m) => m.type === "user" && m.text === "original question")).toBe(true)
    const history = mock.requests[1].messages.map((m) => m.content).join("\n")
    expect(history).toContain("original answer")
    expect(history).toContain("follow up")
  })

  test("tool calls run through the server and their results are stored", async () => {
    await using env = await setup([
      { toolCalls: [{ name: "write", input: { path: "from-server.txt", content: "written via api" } }] },
      { toolCalls: [{ name: "shell", input: { command: "cat from-server.txt" } }] },
      { text: "finished" },
    ])
    const { server, ws, mock } = env
    const session = await createSession(server, ws)
    const messages = await promptAndWait(server, session.id, "write then cat")
    expect(await ws.read("from-server.txt")).toBe("written via api")
    expect(mock.toolResults(2).at(-1)!.content).toContain("written via api")
    const tools = messages.flatMap((m) => (m.type === "assistant" ? m.content : [])).filter((c: any) => c.type === "tool")
    expect(tools.map((t: any) => [t.name, t.state.status])).toEqual(
      expect.arrayContaining([
        ["write", "completed"],
        ["shell", "completed"],
      ]),
    )
  })
})

describe("opencode serve: events", () => {
  test("streams the agent loop as server-sent events", async () => {
    await using env = await setup([{ text: "streamed words arrive in pieces", chunkDelayMs: 100 }])
    const { server, ws } = env
    const events = server.events()
    await events.connected
    expect(events.events[0].type).toBe("server.connected")
    const session = await createSession(server, ws)
    await server.api("POST", `/api/session/${session.id}/prompt`, { text: "stream please" })
    await events.waitFor((e) => e.type === "session.execution.succeeded" && e.data.sessionID === session.id)
    const mine = events.events.filter((e) => e.data?.sessionID === session.id)
    const types = mine.map((e) => e.type)
    const order = ["session.execution.started", "session.step.started", "session.text.started", "session.text.delta", "session.text.ended", "session.step.ended", "session.execution.succeeded"]
    const positions = order.map((t) => types.indexOf(t))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    const deltas = mine.filter((e) => e.type === "session.text.delta").map((e) => e.data.delta)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join("")).toBe("streamed words arrive in pieces")
    await events.close()
  })

  test("the types query filters the stream", async () => {
    await using env = await setup([{ text: "filtered" }])
    const { server, ws } = env
    const events = server.events(["session.execution.succeeded"])
    await events.connected
    const session = await createSession(server, ws)
    await server.api("POST", `/api/session/${session.id}/prompt`, { text: "go" })
    await events.waitFor((e) => e.type === "session.execution.succeeded")
    await Bun.sleep(200)
    expect(new Set(events.events.map((e) => e.type))).toEqual(new Set(["server.connected", "session.execution.succeeded"]))
    await events.close()
  })

  test("tool lifecycle events are emitted", async () => {
    await using env = await setup([{ toolCalls: [{ name: "shell", input: { command: "echo evt" } }] }, { text: "ok" }])
    const { server, ws } = env
    const events = server.events()
    await events.connected
    const session = await createSession(server, ws)
    await server.api("POST", `/api/session/${session.id}/prompt`, { text: "run a tool" })
    await events.waitFor((e) => e.type === "session.execution.succeeded" && e.data.sessionID === session.id)
    const types = events.events.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(["session.tool.called", "session.tool.success"]))
    expect(types.indexOf("session.tool.called")).toBeLessThan(types.indexOf("session.tool.success"))
    await events.close()
  })
})

describe("opencode serve: permissions and control", () => {
  const askShell = { permissions: [...directTools, { action: "shell", resource: "*", effect: "ask" }] }

  test("an ask rule pauses for approval; approving runs the command", async () => {
    await using env = await setup([{ toolCalls: [{ name: "shell", input: { command: "touch approved.txt" } }] }, { text: "done" }], askShell)
    const { server, ws } = env
    const events = server.events()
    await events.connected
    const session = await createSession(server, ws)
    await server.api("POST", `/api/session/${session.id}/prompt`, { text: "touch it" })
    const asked = await events.waitFor((e) => e.type === "permission.asked")
    expect(asked.data).toMatchObject({ sessionID: session.id, action: "shell" })
    expect(asked.data.resources.join(" ")).toContain("touch approved.txt")
    expect(await ws.exists("approved.txt")).toBe(false)
    const pending = await server.api("GET", `/api/session/${session.id}/permission`)
    expect(JSON.stringify(pending.json)).toContain(asked.data.id)
    const reply = await server.api("POST", `/api/session/${session.id}/permission/${asked.data.id}/reply`, { decision: "once" })
    expect(reply.status).toBe(204)
    await server.api("POST", `/api/experimental/session/${session.id}/wait`)
    expect(await ws.exists("approved.txt")).toBe(true)
    await events.close()
  })

  test("rejecting a permission request blocks the command and tells the model", async () => {
    await using env = await setup([{ toolCalls: [{ name: "shell", input: { command: "touch rejected.txt" } }] }, { text: "ok, not doing it" }], askShell)
    const { server, ws, mock } = env
    const events = server.events()
    await events.connected
    const session = await createSession(server, ws)
    await server.api("POST", `/api/session/${session.id}/prompt`, { text: "touch it" })
    const asked = await events.waitFor((e) => e.type === "permission.asked")
    const reply = await server.api("POST", `/api/session/${session.id}/permission/${asked.data.id}/reply`, {
      decision: "reject",
      message: "not allowed in tests",
    })
    expect(reply.status).toBe(204)
    await server.api("POST", `/api/experimental/session/${session.id}/wait`)
    expect(await ws.exists("rejected.txt")).toBe(false)
    expect(mock.requests).toHaveLength(2)
    expect(mock.toolResults(1)[0].content).toContain("not allowed in tests")
    await events.close()
  })

  test("interrupt stops a running generation", async () => {
    await using env = await setup([{ text: "this never finishes", hang: true }])
    const { server, ws, mock } = env
    const events = server.events()
    await events.connected
    const session = await createSession(server, ws)
    await server.api("POST", `/api/session/${session.id}/prompt`, { text: "start something long" })
    await mock.waitForRequests(1)
    await events.waitFor((e) => e.type === "session.text.delta" && e.data.sessionID === session.id)
    const interrupt = await server.api("POST", `/api/session/${session.id}/interrupt`)
    expect(interrupt.status).toBe(200)
    expect(interrupt.json).toEqual({ interrupted: true })
    await events.waitFor((e) => e.type === "session.execution.interrupted" && e.data.sessionID === session.id, 15_000)
    const idle = await server.api("POST", `/api/session/${session.id}/interrupt`)
    expect(idle.json).toEqual({ interrupted: false })
    await events.close()
  })
})
