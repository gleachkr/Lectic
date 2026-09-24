import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ContextEnvelope } from "../transcript"

export const root = resolve(import.meta.dir, "../../../..")
export const fakeCommand = [process.execPath, join(
  import.meta.dir, "fixtures/fake-lectic.ts",
)]
export const realCommand = [process.execPath, join(root, "src/main.ts")]

export const backendContext = (): ContextEnvelope => ({
  version: 1, conversationId: "test", sessionId: "s",
  delegationId: "opaque/id:☃", fragments: [
    { speaker: "user", text: "What is", sequence: 0 },
    { speaker: "assistant", text: " Let me check.", sequence: 1 },
    { speaker: "user", text: " the answer?", sequence: 2 },
  ],
})

export async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "live-test-"))
  const cwd = join(dir, "workspace")
  const seedDir = join(cwd, "docs")
  const config = join(dir, "config")
  await mkdir(seedDir, { recursive: true })
  await mkdir(config)
  const env = {
    PATH: process.env["PATH"], HOME: dir,
    LECTIC_CONFIG: config, LECTIC_DATA: join(dir, "data"),
    LECTIC_CACHE: join(dir, "cache"), LECTIC_STATE: join(dir, "state"),
    AGENT: "1",
  }
  await writeFile(join(cwd, "lectic.yaml"), [
    'imports: [./workspace-import.yaml]',
  ].join("\n"))
  await writeFile(join(cwd, "workspace-import.yaml"), [
    'interlocutor:', '  name: Bot', '  provider: ollama',
    '  model: deterministic-live', '  prompt: file:./prompt.txt',
  ].join("\n"))
  await writeFile(join(cwd, "prompt.txt"), "Workspace-relative prompt")
  await writeFile(join(seedDir, "document-import.yaml"), [
    'macros:', '  - name: danger', '    expansion: EXPANDED_UNSAFE',
  ].join("\n"))
  await writeFile(join(cwd, "attachment.txt"), "Relative attachment")
  const seed = join(seedDir, "seed.lec")
  const source = [
    '---', 'imports: [./document-import.yaml]', '---',
    'Prior backend context.', ':danger[]',
    ':fetch[./attachment.txt]', ':env[LECTIC_FILE]', '',
  ].join("\n")
  await writeFile(seed, source)
  return {
    dir, cwd, seed, source, env,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
