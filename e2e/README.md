# OCE2E

Black-box end-to-end tests for [tntnag42/opencode](https://github.com/tntnag42/opencode) (a fork of anomalyco/opencode).

The suite runs the real opencode CLI, server, and TUI as separate processes and points them at a deterministic mock
LLM provider, so it needs no API keys and makes no network calls to model providers.

## Running

```sh
bun install
bun run test
```

`bun run test` first runs `scripts/setup.ts`, which fetches opencode at the commit pinned in
[`opencode.lock.json`](opencode.lock.json) into `.opencode-src/` and runs `bun install` there (once per commit), then
runs `bun test`. A full run takes about five minutes because every test boots opencode from source.

Useful variations:

| Command / variable | Effect |
| --- | --- |
| `bun test tests/server` | Run one area (`cli`, `tools`, `server`, `tui`, `smoke`). |
| `bun test -t "permission"` | Run tests whose name matches. |
| `OPENCODE_SRC=/path/to/opencode` | Test an existing checkout (for example your working copy) instead of the pinned commit. Setup still installs its dependencies. |
| `OPENCODE_REF=<sha or branch>` | Fetch a different fork commit into `.opencode-src/`. |
| `OPENCODE_BIN=/path/to/opencode` | Test a built binary instead of running from source. |
| `OCE2E_REAL_PROVIDER=1 OCE2E_REAL_MODEL=anthropic/claude-haiku-5-5 ANTHROPIC_API_KEY=…` | Also run the opt-in real-provider smoke test (`tests/smoke`), skipped by default. |

To move the pin, edit `ref` in `opencode.lock.json` and run `bun run test`.

CI ([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml)) runs typecheck and the full suite on every push to
`main` and every pull request. Manual dispatch accepts an `opencode_ref` to test another fork commit. The real-provider
job runs only when the repository variable `OCE2E_REAL_PROVIDER` is `1`, using the `OCE2E_REAL_MODEL` variable and
the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` secrets.

## How it works

- **Mock provider** ([`harness/mock-provider.ts`](harness/mock-provider.ts)): a local Bun HTTP server that speaks both
  the OpenAI chat-completions and Anthropic messages streaming APIs. Each test scripts the assistant turns (text,
  reasoning, tool calls, HTTP errors, delays, or a stream that never finishes) and the server replays them in order,
  recording every request so tests can assert on prompts, history, tool results, model IDs, and auth headers.
  Session-title requests are detected and answered separately so they never consume scripted turns.
- **Isolated workspaces** ([`harness/opencode.ts`](harness/opencode.ts)): every test gets a fresh temp directory with
  its own `HOME`, XDG directories, database, global config dir, and a git-initialised project containing an
  `opencode.json` that registers the mock as provider `mock` with models `m1` and `m2`. Free hosted models are
  disabled so a misconfigured test fails instead of reaching the network.
- **Processes**: `run()` / `runCli()` spawn the CLI with the workspace as its working directory; `startServer()`
  starts `opencode serve` on a free port with a known password and wraps the HTTP API and SSE feed.
- **TUI** ([`harness/tui.ts`](harness/tui.ts)): spawns the interactive TUI in a real pseudo-terminal
  (`Bun.spawn`'s `terminal` option) and renders its output with `@xterm/headless`, so tests wait for text to appear on
  the rendered screen rather than sleeping or matching escape codes.

## Coverage

**CLI** ([`tests/cli`](tests/cli))
- `run`: plain and `--format json` output (event stream shape, token usage), multi-word messages, stdin input and
  stdin appended to an argument, empty-message error, `--model` selection and unknown models, `--file` attachments and
  missing files, `--continue`, `--session`, `--fork` validation, `--title`, `--archived`, `--server` against a
  running server (including a wrong password), provider HTTP errors, OpenAI- and Anthropic-compatible providers,
  API-key headers.
- Command surface: `--version`, `--help`, `run --help`, unknown commands/flags/choices (exit 1), `debug paths`,
  `models`, `session list`, `session export`, `session delete`.
- Config loading: global config dir, `OPENCODE_CONFIG_CONTENT`, project-over-global precedence, nested directory
  configs, `.opencode/opencode.json` precedence, JSONC comments and trailing commas, `{env:…}` and `{file:…}`
  substitution, `debug config` (with secret redaction), custom agents via `--agent`, `AGENTS.md` instructions, and
  malformed config.

**Tool execution** ([`tests/tools`](tests/tools)), against temp workspaces
- Direct tools (Code Mode off): `write`, `read` (including missing files), `edit` (single, `replaceAll`,
  ambiguous and missing `oldString`), `shell` (cwd, stdout/stderr, exit codes, `OPENCODE_SESSION_ID`), `glob`,
  `grep`, and a multi-step read → edit → verify loop.
- Code Mode (default): `execute` scripts calling `tools.write/read/edit/shell`, and script errors.
- Anthropic `tool_use` / `tool_result` round trip.
- Permissions: `deny` rules for shell and edit paths, `ask` rules auto-rejected in non-interactive runs, `--auto`
  approving `ask` but not overriding `deny`.

**Server** ([`tests/server`](tests/server)) via `opencode serve`
- Basic auth, `/api/info`, `/openapi.json`, location, provider/model catalog, clean SIGTERM shutdown.
- Sessions: create/get/list/update/delete, 404s, malformed prompt bodies (400), prompting and stored messages, usage
  accounting, multi-turn history, model selection at creation, fork, tool calls through the server.
- Events: SSE ordering of the agent loop, streamed text deltas, `types` filtering, tool lifecycle events.
- Control: permission `ask` → `permission.asked` event → approve / reject over HTTP, and `interrupt` of a running
  generation.

**TUI** ([`tests/tui`](tests/tui)), smoke level: boot screen (agent, model, directory), submitting a prompt and
rendering the reply and generated title, a tool call from the TUI, and exiting with ctrl+c.

**Real provider** ([`tests/smoke`](tests/smoke)): opt-in, see above.

## Known opencode issues

Tests marked `test.failing` document bugs found in opencode at the pinned commit. They pass while the bug exists and
start failing once it is fixed, at which point drop `.failing`.

1. `opencode session list` shows sessions created with `run --archived`, although the flag is documented as keeping
   them "out of session lists". The session is archived (`time.archived` is set and `GET /api/session?archived=false`
   omits it); the CLI's list call just never passes `archived: false`.
   ([`tests/cli/commands.test.ts`](tests/cli/commands.test.ts))
2. The first `GET /api/model` / `GET /api/provider` for a location returns empty lists and `GET /api/model/default`
   returns `null` while the catalog is still loading, instead of waiting; the same requests succeed moments later. A
   client that lists models right after connecting sees none. ([`tests/server/server.test.ts`](tests/server/server.test.ts))
3. A malformed `opencode.json` is silently dropped: the parse error is only logged at WARN (visible with
   `--print-logs`), and the user just sees "No model is available". ([`tests/cli/config.test.ts`](tests/cli/config.test.ts))

## Known gaps

- TUI coverage is a smoke test of the main flow; dialogs, keybinds, themes, and resize behaviour are not covered.
- The background service (`opencode service …`, the default when neither `--standalone` nor `--server` is given) is
  not exercised, because it installs a long-lived per-user daemon. Every test uses `--standalone` or `serve`.
- Not covered: ACP (`opencode acp`), MCP servers, plugins, `auth` login flows, `--worktree`, subagents, compaction,
  revert/snapshots, web fetch/search, image and PDF attachments, the desktop and web apps, and pairing/remote machines.
- Tests run from source on Linux; they are not run against release binaries (use `OPENCODE_BIN`) or on macOS/Windows.
