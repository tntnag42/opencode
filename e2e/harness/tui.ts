import { Terminal } from "@xterm/headless"
import { command, type Workspace } from "./opencode"

/**
 * Drive the interactive TUI in a real pseudo-terminal (Bun.spawn's `terminal` option) and render its output with a
 * headless xterm, so tests can wait for text to appear on screen instead of sleeping or matching raw escape codes.
 */
export async function startTui(ws: Workspace, args: string[] = [], size = { cols: 120, rows: 40 }) {
  const term = new Terminal({ ...size, allowProposedApi: true })
  const listeners = new Set<() => void>()
  const env = { ...ws.env, TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: undefined }
  const proc = Bun.spawn(command(["--standalone", ...args]), {
    cwd: ws.dir,
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    terminal: {
      ...size,
      data(_terminal, data) {
        term.write(data, () => listeners.forEach((listener) => listener()))
      },
    },
  })

  const screen = () => {
    const buffer = term.buffer.active
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n")
  }

  const waitFor = (predicate: string | RegExp | ((screen: string) => boolean), timeoutMs = 30_000) => {
    const matches = () => {
      const text = screen()
      if (typeof predicate === "string") return text.includes(predicate)
      if (predicate instanceof RegExp) return predicate.test(text)
      return predicate(text)
    }
    if (matches()) return Promise.resolve(screen())
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error(`timed out waiting for ${predicate} on screen:\n${screen()}`))
      }, timeoutMs)
      const check = () => {
        if (!matches()) return
        clearTimeout(timer)
        listeners.delete(check)
        resolve(screen())
      }
      listeners.add(check)
    })
  }

  return {
    proc,
    screen,
    waitFor,
    write: (data: string) => proc.terminal!.write(data),
    /** Type text, then press Enter as a separate keystroke so the input does not treat it as a paste. */
    async submit(text: string) {
      proc.terminal!.write(text)
      await waitFor(text)
      proc.terminal!.write("\r")
    },
    async [Symbol.asyncDispose]() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL")
        await proc.exited
      }
      term.dispose()
    },
  }
}
