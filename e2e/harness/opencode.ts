import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import type { MockProvider } from "./mock-provider"

const repoRoot = path.join(import.meta.dir, "..")
const source = process.env.OPENCODE_SRC ?? path.join(repoRoot, ".opencode-src")
const binary = process.env.OPENCODE_BIN

// Run opencode either as a built binary (OPENCODE_BIN) or from source with Bun. From source, the only thing
// packages/cli/bunfig.toml contributes is the OpenTUI Solid preload. It goes in BUN_OPTIONS rather than on the command
// line so that the private server opencode re-spawns from its own entrypoint (run --standalone) inherits it too.
// That lets every process start in the test workspace exactly like an installed binary would.
function resolvePreload() {
  try {
    return Bun.resolveSync("@opentui/solid/preload", path.join(source, "packages/cli"))
  } catch {
    throw new Error(`opencode source not found or not installed at ${source}; run "bun run setup" or set OPENCODE_SRC / OPENCODE_BIN`)
  }
}
const sourceEnv: Record<string, string> = binary ? {} : { BUN_OPTIONS: "--preload=" + resolvePreload() }
export function command(args: string[]) {
  if (binary) return [binary, ...args]
  return [process.execPath, path.join(source, "packages/cli/src/index.ts"), ...args]
}

const transpilerCache = path.join(os.tmpdir(), "oce2e-transpiler-cache")

export type ProviderOptions = {
  id?: string
  api?: "openai" | "anthropic"
  models?: string[]
}

export function providerConfig(mock: MockProvider, options: ProviderOptions = {}) {
  const id = options.id ?? "mock"
  const anthropic = options.api === "anthropic"
  return {
    [id]: {
      name: anthropic ? "Mock Anthropic" : "Mock OpenAI",
      package: anthropic ? "@opencode/ai/providers/anthropic" : "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: mock.url + "/v1", apiKey: "mock-key" },
      models: Object.fromEntries((options.models ?? ["m1", "m2"]).map((m) => [m, { name: m.toUpperCase() }])),
    },
  }
}

/** A rule set that lets the agent use every tool without asking. */
export const allowAll = [{ action: "*", resource: "*", effect: "allow" }]

export type Workspace = Awaited<ReturnType<typeof createWorkspace>>

/**
 * An isolated opencode home: its own HOME, XDG dirs, database, and global config dir, plus a project workspace with an
 * opencode.json pointing at the mock provider. Nothing touches the user's real opencode state.
 */
export async function createWorkspace(
  options: {
    mock?: MockProvider
    provider?: ProviderOptions
    config?: Record<string, unknown>
    /** Write no project opencode.json at all. */
    noProjectConfig?: boolean
    git?: boolean
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oce2e-"))
  const dir = path.join(root, "ws")
  const home = path.join(root, "home")
  const configDir = path.join(home, ".config", "opencode")
  await Promise.all([mkdir(dir, { recursive: true }), mkdir(configDir, { recursive: true })])
  if (options.git ?? true) {
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir])
  }
  const config = {
    ...(options.mock ? { model: `${options.provider?.id ?? "mock"}/m1`, providers: providerConfig(options.mock, options.provider) } : {}),
    permissions: allowAll,
    ...options.config,
  }
  if (!options.noProjectConfig) await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(config, null, 2))

  const env: Record<string, string | undefined> = {
    ...process.env,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
    HOME: home,
    PWD: dir,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CLI_CONFIG_CONTENT: undefined,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    // Never fall back to the hosted free models: a misconfigured test must fail, not reach the network.
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_PASSWORD: undefined,
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    NO_COLOR: "1",
    ...sourceEnv,
  }

  return {
    root,
    dir,
    home,
    configDir,
    env,
    path: (...parts: string[]) => path.join(dir, ...parts),
    write: (file: string, content: string) => Bun.write(path.join(dir, file), content),
    read: (file: string) => Bun.file(path.join(dir, file)).text(),
    exists: (file: string) => Bun.file(path.join(dir, file)).exists(),
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type CliResult = { stdout: string; stderr: string; exitCode: number | null; signalCode: NodeJS.Signals | number | null }

/** Run the opencode CLI to completion inside the workspace. */
export async function runCli(
  ws: Workspace,
  args: string[],
  options: { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<CliResult> {
  const env = { ...ws.env, ...(options.cwd ? { PWD: options.cwd } : {}), ...options.env }
  const child = Bun.spawn(command(args), {
    cwd: options.cwd ?? ws.dir,
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? 45_000,
    killSignal: "SIGKILL",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  return { stdout, stderr, exitCode: child.exitCode, signalCode: child.signalCode }
}

/** `opencode run --standalone`: a one-shot run against a private server, so no background service is involved. */
export function run(ws: Workspace, args: string[], options?: Parameters<typeof runCli>[2]) {
  return runCli(ws, ["run", "--standalone", ...args], options)
}

/** Parse `--format json` output: one JSON event per line. */
export function parseJsonLines(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line))
}

export type Server = Awaited<ReturnType<typeof startServer>>

/** Start `opencode serve` on a free port with a known password and wait for it to listen. */
export async function startServer(ws: Workspace, options: { password?: string; args?: string[] } = {}) {
  const password = options.password ?? "e2e-password"
  const env = { ...ws.env, OPENCODE_PASSWORD: password }
  const child = Bun.spawn(command(["serve", "--port", "0", ...(options.args ?? [])]), {
    cwd: ws.dir,
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let output = ""
  const decoder = new TextDecoder()
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 30_000)
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        output += decoder.decode(chunk)
        const match = output.match(/listening on (http:\/\/\S+)/)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
    }
    void pump(child.stdout)
    void pump(child.stderr)
    void child.exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`server exited with ${code} before listening:\n${output}`))
    })
  })
  const auth = "Basic " + btoa(`opencode:${password}`)
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: auth,
    "x-opencode-directory": encodeURIComponent(ws.dir),
    ...extra,
  })
  const api = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(url + route, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: response.status, json, text }
  }
  return {
    url,
    password,
    process: child,
    output: () => output,
    headers,
    api,
    events: (types?: string[]) => subscribe(url + "/api/event" + (types ? "?" + types.map((t) => "types=" + t).join("&") : ""), headers()),
    async stop() {
      child.kill("SIGTERM")
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => undefined)])
      if (exited === undefined) {
        child.kill("SIGKILL")
        await child.exited
      }
      return child.exitCode
    },
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) await this.stop()
    },
  }
}

export type ServerEvent = { id: string; type: string; data: any; location?: unknown }

/** Subscribe to the server's SSE feed and buffer every event. */
export function subscribe(url: string, headers: Record<string, string>) {
  const events: ServerEvent[] = []
  const listeners = new Set<() => void>()
  const controller = new AbortController()
  const connected = Promise.withResolvers<void>()
  const done = (async () => {
    const response = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`)
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let split
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        const event = JSON.parse(data) as ServerEvent
        events.push(event)
        if (event.type === "server.connected") connected.resolve()
        for (const listener of listeners) listener()
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) connected.reject(error)
  })
  return {
    events,
    connected: connected.promise,
    /** Wait for the first buffered or future event matching the predicate. */
    waitFor(predicate: (event: ServerEvent) => boolean, timeoutMs = 30_000) {
      const found = events.find(predicate)
      if (found) return Promise.resolve(found)
      return new Promise<ServerEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check)
          reject(new Error(`timed out waiting for event; saw: ${events.map((e) => e.type).join(", ")}`))
        }, timeoutMs)
        const check = () => {
          const match = events.find(predicate)
          if (!match) return
          clearTimeout(timer)
          listeners.delete(check)
          resolve(match)
        }
        listeners.add(check)
      })
    },
    close() {
      controller.abort()
      return done
    },
  }
}
