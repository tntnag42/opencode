import { describe, expect, test, setDefaultTimeout } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { startMockProvider } from "../../harness/mock-provider"
import { allowAll, createWorkspace, providerConfig, run, runCli } from "../../harness/opencode"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

describe("config loading", () => {
  test("a global config in the config dir is used when the project has none", async () => {
    await using mock = await startMockProvider({ script: [{ text: "from global config" }] })
    await using ws = await createWorkspace({ noProjectConfig: true })
    await Bun.write(
      path.join(ws.configDir, "opencode.json"),
      JSON.stringify({ model: "mock/m1", providers: providerConfig(mock), permissions: allowAll }),
    )
    const result = await run(ws, ["hi"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("from global config")
  })

  test("OPENCODE_CONFIG_CONTENT supplies inline config", async () => {
    await using mock = await startMockProvider({ script: [{ text: "from env config" }] })
    await using ws = await createWorkspace({ noProjectConfig: true })
    const result = await run(ws, ["hi"], {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "mock/m2", providers: providerConfig(mock), permissions: allowAll }) },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("from env config")
    expect(mock.requests[0].model).toBe("m2")
  })

  test("project config overrides the global default model", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    await Bun.write(path.join(ws.configDir, "opencode.json"), JSON.stringify({ model: "mock/m2" }))
    expect((await run(ws, ["hi"])).exitCode).toBe(0)
    expect(mock.requests[0].model).toBe("m1")
  })

  test("a nested directory config overrides the repository config", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    const nested = ws.path("packages", "web")
    await mkdir(nested, { recursive: true })
    await Bun.write(path.join(nested, "opencode.json"), JSON.stringify({ model: "mock/m2" }))
    expect((await run(ws, ["hi"], { cwd: nested })).exitCode).toBe(0)
    expect(mock.requests[0].model).toBe("m2")
  })

  test(".opencode/opencode.json overrides a direct opencode.json in the same directory", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    await ws.write(".opencode/opencode.json", JSON.stringify({ model: "mock/m2" }))
    expect((await run(ws, ["hi"])).exitCode).toBe(0)
    expect(mock.requests[0].model).toBe("m2")
  })

  test("opencode.jsonc accepts comments and trailing commas", async () => {
    await using mock = await startMockProvider({ script: [{ text: "jsonc works" }] })
    await using ws = await createWorkspace({ noProjectConfig: true })
    const body = JSON.stringify({ model: "mock/m1", providers: providerConfig(mock), permissions: allowAll }, null, 2)
    await ws.write("opencode.jsonc", "// leading comment\n" + body.replace(/\n}$/, ",\n  /* trailing */\n}"))
    const result = await run(ws, ["hi"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("jsonc works")
  })

  test("{env:VAR} substitution fills provider settings", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ noProjectConfig: true })
    const providers = providerConfig(mock)
    providers.mock.settings.apiKey = "{env:OCE2E_MOCK_KEY}"
    await ws.write("opencode.json", JSON.stringify({ model: "mock/m1", providers, permissions: allowAll }))
    const result = await run(ws, ["hi"], { env: { OCE2E_MOCK_KEY: "key-from-env" } })
    expect(result.exitCode).toBe(0)
    expect(mock.requests[0].headers.authorization).toBe("Bearer key-from-env")
  })

  test("{file:path} substitution reads a file relative to the config", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ noProjectConfig: true })
    await ws.write("key.txt", "key-from-file")
    const providers = providerConfig(mock)
    providers.mock.settings.apiKey = "{file:key.txt}"
    await ws.write("opencode.json", JSON.stringify({ model: "mock/m1", providers, permissions: allowAll }))
    expect((await run(ws, ["hi"])).exitCode).toBe(0)
    expect(mock.requests[0].headers.authorization).toBe("Bearer key-from-file")
  })

  test("debug config reports the loaded documents and redacts secrets", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ mock })
    const result = await runCli(ws, ["debug", "config", "--standalone"])
    expect(result.exitCode).toBe(0)
    const documents = JSON.parse(result.stdout)
    const project = documents.find((d: any) => d.path === ws.path("opencode.json"))
    expect(project.info.providers.mock.settings.baseURL).toBe(mock.url + "/v1")
    expect(result.stdout).not.toContain("mock-key")
  })

  test("a custom agent from config can be selected with --agent and contributes its system prompt", async () => {
    await using mock = await startMockProvider({ script: [{ text: "agent reply" }] })
    await using ws = await createWorkspace({
      mock,
      config: { agents: { reviewer: { mode: "primary", description: "Reviews code", system: "OCE2E-REVIEWER-SYSTEM-PROMPT" } } },
    })
    const result = await run(ws, ["--agent", "reviewer", "review this"])
    expect(result.exitCode).toBe(0)
    expect(mock.requests[0].system).toContain("OCE2E-REVIEWER-SYSTEM-PROMPT")
    expect(result.stderr).toContain("reviewer")
  })

  test("AGENTS.md instructions in the workspace reach the model", async () => {
    await using mock = await startMockProvider({ script: [{ text: "ok" }] })
    await using ws = await createWorkspace({ mock })
    await ws.write("AGENTS.md", "# Rules\nOCE2E-PROJECT-INSTRUCTION: always answer in haiku.\n")
    expect((await run(ws, ["hi"])).exitCode).toBe(0)
    const sent = mock.requests[0].system + mock.requests[0].messages.map((m) => m.content).join("\n")
    expect(sent).toContain("OCE2E-PROJECT-INSTRUCTION")
  })

  test("a malformed project config is dropped and the run fails for lack of a model", async () => {
    await using mock = await startMockProvider()
    await using ws = await createWorkspace({ noProjectConfig: true })
    await ws.write("opencode.json", "{ this is not json")
    const result = await run(ws, ["hi"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No model is available")
    expect(mock.requests).toHaveLength(0)
  })

  // Known issue: the parse error is only logged at WARN (visible with --print-logs); the user just sees
  // "No model is available" with no hint that opencode.json was rejected. Remove .failing once surfaced.
  test.failing("a malformed project config is reported to the user", async () => {
    await using ws = await createWorkspace({ noProjectConfig: true })
    await ws.write("opencode.json", "{ this is not json")
    const result = await run(ws, ["hi"])
    expect(result.stdout + result.stderr).toContain("opencode.json")
  })
})
