import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { startMockProvider, type Turn } from "../../harness/mock-provider"
import { allowAll, createWorkspace, parseJsonLines, run } from "../../harness/opencode"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

// Denying `execute` turns Code Mode off, so every built-in tool is offered to the model as a direct tool call.
const directTools = { permissions: [...allowAll, { action: "execute", resource: "*", effect: "deny" }] }

async function runTool(turns: Turn[], setup?: (ws: Awaited<ReturnType<typeof createWorkspace>>) => Promise<unknown>, config: Record<string, unknown> = directTools, args: string[] = []) {
  const mock = await startMockProvider({ script: [...turns, { text: "all done" }] })
  const ws = await createWorkspace({ mock, config })
  await setup?.(ws)
  const result = await run(ws, ["--format", "json", ...args, "use your tools"])
  return { mock, ws, result, events: parseJsonLines(result.stdout) }
}

const toolParts = (events: any[]) => events.filter((e) => e.type === "tool_use").map((e) => e.part)

describe("direct tools", () => {
  test("offers the built-in file and shell tools when Code Mode is off", async () => {
    const { mock, ws, result } = await runTool([])
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(mock.requests[0].tools).toEqual(expect.arrayContaining(["read", "write", "edit", "shell", "glob", "grep"]))
    expect(mock.requests[0].tools).not.toContain("execute")
  })

  test("write creates a file in the workspace", async () => {
    const { mock, ws, result, events } = await runTool([
      { toolCalls: [{ name: "write", input: { path: "src/new.txt", content: "line one\nline two\n" } }] },
    ])
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.read("src/new.txt")).toBe("line one\nline two\n")
    expect(mock.toolResults()[0].content).toContain("src/new.txt")
    expect(toolParts(events)[0]).toMatchObject({ tool: "write", state: { status: "completed" } })
    expect(result.stdout).toContain("all done")
  })

  test("read returns file contents to the model", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "read", input: { path: "data.txt" } }] }],
      (ws) => ws.write("data.txt", "alpha\nbeta\ngamma\n"),
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    const content = mock.toolResults()[0].content
    expect(content).toContain("alpha")
    expect(content).toContain("gamma")
  })

  test("read of a missing file reports an error to the model and the run continues", async () => {
    const { mock, ws, result, events } = await runTool([{ toolCalls: [{ name: "read", input: { path: "nope.txt" } }] }])
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(mock.requests).toHaveLength(2)
    expect(mock.toolResults()[0].content.toLowerCase()).toMatch(/not found|no such file|does not exist|enoent/)
    expect(toolParts(events)[0].state.status).toBe("error")
  })

  test("edit replaces exactly one occurrence", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "edit", input: { path: "app.ts", oldString: "const x = 1", newString: "const x = 2" } }] }],
      (ws) => ws.write("app.ts", "const x = 1\nconst y = 1\n"),
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.read("app.ts")).toBe("const x = 2\nconst y = 1\n")
  })

  test("edit with replaceAll replaces every occurrence", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "edit", input: { path: "a.txt", oldString: "foo", newString: "bar", replaceAll: true } }] }],
      (ws) => ws.write("a.txt", "foo foo\nfoo\n"),
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.read("a.txt")).toBe("bar bar\nbar\n")
  })

  test("edit with an ambiguous oldString fails and leaves the file untouched", async () => {
    const { mock, ws, result, events } = await runTool(
      [{ toolCalls: [{ name: "edit", input: { path: "a.txt", oldString: "foo", newString: "bar" } }] }],
      (ws) => ws.write("a.txt", "foo\nfoo\n"),
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.read("a.txt")).toBe("foo\nfoo\n")
    expect(toolParts(events)[0].state.status).toBe("error")
    expect(mock.requests).toHaveLength(2)
  })

  test("edit with an oldString that is not present fails", async () => {
    const { mock, ws, result, events } = await runTool(
      [{ toolCalls: [{ name: "edit", input: { path: "a.txt", oldString: "missing", newString: "x" } }] }],
      (ws) => ws.write("a.txt", "content\n"),
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.read("a.txt")).toBe("content\n")
    expect(toolParts(events)[0].state.status).toBe("error")
  })

  test("shell runs in the workspace and reports output and exit code", async () => {
    const { mock, ws, result } = await runTool([
      { toolCalls: [{ name: "shell", input: { command: "pwd && echo hello-shell > out.txt && echo to-stderr >&2 && exit 4" } }] },
    ])
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.read("out.txt")).toBe("hello-shell\n")
    const content = mock.toolResults()[0].content
    expect(content).toContain(ws.dir)
    expect(content).toContain("to-stderr")
    expect(content).toContain("Exit code: 4")
  })

  test("shell exposes the session ID to the command", async () => {
    const { mock, ws, result, events } = await runTool([{ toolCalls: [{ name: "shell", input: { command: "echo $OPENCODE_SESSION_ID" } }] }])
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(mock.toolResults()[0].content).toContain(events[0].sessionID)
  })

  test("glob and grep find files in the workspace", async () => {
    const { mock, ws, result } = await runTool(
      [
        {
          toolCalls: [
            { name: "glob", input: { pattern: "**/*.md" } },
            { name: "grep", input: { pattern: "needle-[0-9]+" } },
          ],
        },
      ],
      async (ws) => {
        await ws.write("docs/guide.md", "# guide\n")
        await ws.write("docs/other.txt", "haystack needle-42 haystack\n")
      },
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    const [glob, grep] = mock.toolResults()
    expect(glob.content).toContain("guide.md")
    expect(glob.content).not.toContain("other.txt")
    expect(grep.content).toContain("other.txt")
  })

  test("multi-step tool loop: the model reads, edits, then verifies with shell", async () => {
    const { mock, ws, result } = await runTool(
      [
        { toolCalls: [{ name: "read", input: { path: "version.txt" } }] },
        { toolCalls: [{ name: "edit", input: { path: "version.txt", oldString: "1.0.0", newString: "1.1.0" } }] },
        { toolCalls: [{ name: "shell", input: { command: "cat version.txt" } }] },
      ],
      (ws) => ws.write("version.txt", "1.0.0\n"),
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(mock.requests).toHaveLength(4)
    expect(mock.toolResults(1)[0].content).toContain("1.0.0")
    expect(mock.toolResults(3).at(-1)!.content).toContain("1.1.0")
    expect(await ws.read("version.txt")).toBe("1.1.0\n")
  })
})

describe("anthropic tool calls", () => {
  test("tool_use blocks from an Anthropic-compatible API run and return tool_result", async () => {
    await using mock = await startMockProvider({
      script: [{ toolCalls: [{ name: "shell", input: { command: "echo via-anthropic > a.txt && cat a.txt" } }] }, { text: "anthropic done" }],
    })
    await using ws = await createWorkspace({ mock, provider: { api: "anthropic" }, config: directTools })
    const result = await run(ws, ["run it"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("anthropic done")
    expect(await ws.read("a.txt")).toBe("via-anthropic\n")
    expect(mock.requests[1].api).toBe("anthropic")
    expect(mock.toolResults(1)[0]).toMatchObject({ toolCallID: "toolu_0", content: expect.stringContaining("via-anthropic") })
  })
})

describe("code mode", () => {
  test("execute is offered and the file tools are reachable from JavaScript", async () => {
    const { mock, ws, result } = await runTool(
      [
        {
          toolCalls: [
            {
              name: "execute",
              input: {
                code: [
                  "await tools.write({ path: 'cm.txt', content: 'code mode' })",
                  "const read = await tools.read({ path: 'cm.txt' })",
                  "await tools.edit({ path: 'cm.txt', oldString: 'code', newString: 'CODE' })",
                  "const shell = await tools.shell({ command: 'cat cm.txt; exit 3' })",
                  "return { read: read.content, exit: shell.exitCode, out: shell.output }",
                ].join("\n"),
              },
            },
          ],
        },
      ],
      undefined,
      { permissions: allowAll },
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(mock.requests[0].tools).toContain("execute")
    expect(mock.requests[0].tools).not.toContain("write")
    expect(JSON.parse(mock.toolResults()[0].content)).toEqual({ read: "code mode", exit: 3, out: "CODE mode" })
    expect(await ws.read("cm.txt")).toBe("CODE mode")
  })

  test("a script that throws reports the error to the model", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "execute", input: { code: "throw new Error('boom from script')" } }] }],
      undefined,
      { permissions: allowAll },
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(mock.toolResults()[0].content).toContain("boom from script")
  })
})

describe("permissions", () => {
  test("a deny rule blocks a shell command and the model is told", async () => {
    const { mock, ws, result, events } = await runTool(
      [{ toolCalls: [{ name: "shell", input: { command: "touch forbidden.txt" } }] }],
      undefined,
      { permissions: [...directTools.permissions, { action: "shell", resource: "touch *", effect: "deny" }] },
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.exists("forbidden.txt")).toBe(false)
    expect(toolParts(events)[0].state.status).toBe("error")
    expect(mock.requests).toHaveLength(2)
  })

  test("a deny rule on edit protects matching paths but not others", async () => {
    const { mock, ws, result } = await runTool(
      [
        {
          toolCalls: [
            { name: "write", input: { path: "secrets/key.txt", content: "leak" } },
            { name: "write", input: { path: "public.txt", content: "fine" } },
          ],
        },
      ],
      undefined,
      { permissions: [...directTools.permissions, { action: "edit", resource: "secrets/*", effect: "deny" }] },
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.exists("secrets/key.txt")).toBe(false)
    expect(await ws.read("public.txt")).toBe("fine")
  })

  test("an ask rule in a non-interactive run without --auto is auto-rejected and the model is told", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "shell", input: { command: "touch asked.txt" } }] }],
      undefined,
      { permissions: [...directTools.permissions, { action: "shell", resource: "*", effect: "ask" }] },
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("permission requested: shell (touch asked.txt); auto-rejecting")
    expect(await ws.exists("asked.txt")).toBe(false)
    expect(mock.toolResults()[0].content).toContain("permission.rejected")
    expect(result.stdout).toContain("all done")
  })

  test("--auto approves ask rules", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "shell", input: { command: "touch approved.txt" } }] }],
      undefined,
      { permissions: [...directTools.permissions, { action: "shell", resource: "*", effect: "ask" }] },
      ["--auto"],
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.exists("approved.txt")).toBe(true)
  })

  test("--auto does not override an explicit deny", async () => {
    const { mock, ws, result } = await runTool(
      [{ toolCalls: [{ name: "shell", input: { command: "touch denied.txt" } }] }],
      undefined,
      { permissions: [...directTools.permissions, { action: "shell", resource: "*", effect: "deny" }] },
      ["--auto"],
    )
    await using _m = mock
    await using _w = ws
    expect(result.exitCode).toBe(0)
    expect(await ws.exists("denied.txt")).toBe(false)
  })
})
