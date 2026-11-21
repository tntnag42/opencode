import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { startMockProvider } from "../../harness/mock-provider"
import { createWorkspace, parseJsonLines, run, runCli, startServer } from "../../harness/opencode"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

describe("CLI surface", () => {
  test("--version prints the version and exits 0", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["--version"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^opencode v\S+$/)
  })

  test("--help lists the main subcommands and exits 0", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["--help"])
    expect(result.exitCode).toBe(0)
    for (const command of ["run", "serve", "models", "session"]) expect(result.stdout).toContain(command)
  })

  test("run --help documents the run flags", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["run", "--help"])
    expect(result.exitCode).toBe(0)
    for (const flag of ["--continue", "--session", "--model", "--format", "--file", "--agent", "--title"]) expect(result.stdout).toContain(flag)
  })

  test("an unknown subcommand exits 1 with an error", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["definitely-not-a-command"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('No directory or command named "definitely-not-a-command"')
  })

  test("an unknown flag exits 1 with an error", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["run", "--not-a-flag", "hi"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unrecognized flag: --not-a-flag")
  })

  test("an invalid --format choice exits 1", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["run", "--format", "xml", "hi"])
    expect(result.exitCode).toBe(1)
  })

  test("debug paths honors the isolated XDG environment", async () => {
    await using ws = await createWorkspace()
    const result = await runCli(ws, ["debug", "paths", "data"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().startsWith(ws.home)).toBe(true)
  })
})

describe("models and sessions commands", () => {
  test("models lists the configured provider models", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ mock })
    const result = await runCli(ws, ["models", "--standalone"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split("\n").sort()).toEqual(["mock/m1", "mock/m2"])
  })

  test("session list shows sessions created by run, with --title applied", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    const ran = await run(ws, ["--format", "json", "--title", "Titled by flag", "hello"])
    expect(ran.exitCode).toBe(0)
    const sessionID = parseJsonLines(ran.stdout)[0].sessionID
    const list = await runCli(ws, ["session", "list", "--standalone", "--format", "json"])
    expect(list.exitCode).toBe(0)
    const sessions = JSON.parse(list.stdout)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: sessionID, title: "Titled by flag", directory: ws.dir })
  })

  test("run --server attaches to a running server; --archived archives the new session", async () => {
    await using mock = await startMockProvider({ script: [{ text: "via external server" }] })
    await using ws = await createWorkspace({ mock })
    await using server = await startServer(ws)
    const ran = await runCli(ws, ["run", "--server", server.url, "--archived", "--format", "json", "hello"], {
      env: { OPENCODE_PASSWORD: server.password },
    })
    expect(ran.exitCode).toBe(0)
    const sessionID = parseJsonLines(ran.stdout)[0].sessionID
    const session = await server.api("GET", `/api/session/${sessionID}`)
    expect(session.json.data.time.archived).toEqual(expect.any(Number))
    expect((await server.api("GET", "/api/session?archived=false")).json.data).toEqual([])
  })

  test("run --server with the wrong password fails without running the prompt", async () => {
    await using mock = await startMockProvider({ script: [{ text: "never" }] })
    await using ws = await createWorkspace({ mock })
    await using server = await startServer(ws)
    const ran = await runCli(ws, ["run", "--server", server.url, "hello"], { env: { OPENCODE_PASSWORD: "wrong" } })
    expect(ran.exitCode).not.toBe(0)
    expect(mock.requests).toHaveLength(0)
  })

  // Known issue: `run --archived` is documented as keeping the session "out of session lists", and the session is
  // archived (see above), but `opencode session list` never passes archived=false, so it still lists it.
  test.failing("session list hides sessions created with run --archived", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    expect((await run(ws, ["--archived", "hello"])).exitCode).toBe(0)
    const list = await runCli(ws, ["session", "list", "--standalone", "--format", "json"])
    expect(JSON.parse(list.stdout)).toEqual([])
  })

  test("session export and delete operate on a run's session", async () => {
    await using mock = await startMockProvider({ script: [{ text: "exported answer" }] })
    await using ws = await createWorkspace({ mock })
    const ran = await run(ws, ["--format", "json", "export me"])
    const sessionID = parseJsonLines(ran.stdout)[0].sessionID
    const exported = await runCli(ws, ["session", "export", "--standalone", sessionID])
    expect(exported.exitCode).toBe(0)
    expect(exported.stdout).toContain("export me")
    expect(exported.stdout).toContain("exported answer")
    const deleted = await runCli(ws, ["session", "delete", "--standalone", sessionID])
    expect(deleted.exitCode).toBe(0)
    const list = await runCli(ws, ["session", "list", "--standalone", "--format", "json"])
    expect(JSON.parse(list.stdout)).toEqual([])
  })
})
