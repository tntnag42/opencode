import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { startMockProvider } from "../../harness/mock-provider"
import { allowAll, createWorkspace } from "../../harness/opencode"
import { startTui } from "../../harness/tui"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

describe("interactive TUI (pty)", () => {
  test("boots to the prompt showing the configured agent, model, and directory", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ mock })
    await using tui = await startTui(ws)
    const screen = await tui.waitFor("Mock OpenAI")
    expect(screen).toContain("Build")
    expect(screen).toContain("M1")
    expect(screen).toContain(ws.dir)
    expect(mock.requests).toHaveLength(0)
  })

  test("submitting a prompt renders the streamed reply and the generated title", async () => {
    await using mock = await startMockProvider({ script: [{ text: "TUI-REPLY-FROM-MOCK" }], title: "Pty session title" })
    await using ws = await createWorkspace({ mock })
    await using tui = await startTui(ws)
    await tui.waitFor("Mock OpenAI")
    await tui.submit("hello from the pty")
    const screen = await tui.waitFor((s) => s.includes("TUI-REPLY-FROM-MOCK") && s.includes("Pty session title"))
    expect(screen).toContain("hello from the pty")
    expect(mock.lastUserMessage()).toContain("hello from the pty")
  })

  test("tool calls run from the TUI and show up in the transcript", async () => {
    await using mock = await startMockProvider({
      script: [{ toolCalls: [{ name: "write", input: { path: "tui-made.txt", content: "made in tui" } }] }, { text: "TOOL-LOOP-DONE" }],
    })
    await using ws = await createWorkspace({
      mock,
      config: { permissions: [...allowAll, { action: "execute", resource: "*", effect: "deny" }] },
    })
    await using tui = await startTui(ws)
    await tui.waitFor("Mock OpenAI")
    await tui.submit("write a file")
    const screen = await tui.waitFor("TOOL-LOOP-DONE")
    expect(screen).toContain("1 edit")
    expect(await ws.read("tui-made.txt")).toBe("made in tui")
  })

  test("ctrl+c twice exits cleanly", async () => {
    await using ws = await createWorkspace()
    await using tui = await startTui(ws)
    await tui.waitFor("Ask anything")
    tui.write("\x03")
    await Bun.sleep(300)
    tui.write("\x03")
    const code = await Promise.race([tui.proc.exited, Bun.sleep(15_000).then(() => "timeout")])
    expect(code).toBe(0)
  })
})
