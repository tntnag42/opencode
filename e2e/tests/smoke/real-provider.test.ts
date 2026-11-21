import { expect, test, setDefaultTimeout } from "bun:test"
import { allowAll, createWorkspace, parseJsonLines, run } from "../../harness/opencode"

// Every test boots at least one opencode process; bun only honors this per file, not from bunfig or a preload.
setDefaultTimeout(90_000)

// Opt-in smoke test against a real LLM provider. Skipped unless OCE2E_REAL_PROVIDER=1.
//   OCE2E_REAL_MODEL   provider/model to use, e.g. anthropic/claude-haiku-5-5 (required)
//   plus that provider's usual credential variable, e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY.
const enabled = process.env.OCE2E_REAL_PROVIDER === "1"
const model = process.env.OCE2E_REAL_MODEL

test.skipIf(!enabled)("real provider: answers a prompt and runs a shell tool", async () => {
  if (!model) throw new Error("OCE2E_REAL_MODEL must be set when OCE2E_REAL_PROVIDER=1")
  await using ws = await createWorkspace({ config: { model, permissions: allowAll } })
  await ws.write("marker.txt", "OCE2E-MARKER-7731\n")
  const credentials = Object.fromEntries(
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"].map((k) => [k, process.env[k]]),
  )
  const result = await run(
    ws,
    ["--format", "json", "Use the shell to run 'cat marker.txt', then reply with only the text that file contains."],
    { env: { ...credentials, OPENCODE_DISABLE_MODELS_FETCH: undefined }, timeoutMs: 180_000 },
  )
  expect(result.exitCode).toBe(0)
  const events = parseJsonLines(result.stdout)
  expect(events.some((e) => e.type === "tool_use")).toBe(true)
  const text = events.filter((e) => e.type === "text").map((e) => e.part.text).join("")
  expect(text).toContain("OCE2E-MARKER-7731")
}, 200_000)
