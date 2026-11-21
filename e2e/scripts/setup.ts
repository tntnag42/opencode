import path from "node:path"
import { existsSync } from "node:fs"

// Fetches opencode at the commit pinned in opencode.lock.json into .opencode-src and installs its dependencies.
// Set OPENCODE_SRC to an existing checkout, or OPENCODE_BIN to a built binary, to skip this step.
const root = path.join(import.meta.dir, "..")
const lock = await Bun.file(path.join(root, "opencode.lock.json")).json()
const repo = process.env.OPENCODE_REPO ?? lock.repo
const ref = process.env.OPENCODE_REF ?? lock.ref

if (process.env.OPENCODE_BIN) {
  console.log(`setup: using OPENCODE_BIN=${process.env.OPENCODE_BIN}`)
  process.exit(0)
}

const dir = process.env.OPENCODE_SRC ?? path.join(root, ".opencode-src")

const sh = (cmd: string[], cwd = dir) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed with exit code ${result.exitCode}`)
}
const head = () => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim()

if (process.env.OPENCODE_SRC) {
  console.log(`setup: using OPENCODE_SRC=${dir} at ${head()}`)
} else {
  if (!existsSync(path.join(dir, ".git"))) {
    sh(["git", "init", "-q", dir], root)
    sh(["git", "remote", "add", "origin", repo])
  }
  if (head() !== ref) {
    console.log(`setup: fetching ${repo} @ ${ref}`)
    sh(["git", "fetch", "-q", "--depth", "1", "origin", ref])
    sh(["git", "checkout", "-q", "--force", "FETCH_HEAD"])
  }
  console.log(`setup: opencode source at ${dir} (${head()})`)
}

const stamp = path.join(dir, "node_modules", ".oce2e-installed")
if (!existsSync(stamp) || (await Bun.file(stamp).text()) !== head()) {
  sh(["bun", "install", "--frozen-lockfile"])
  await Bun.write(stamp, head())
}
