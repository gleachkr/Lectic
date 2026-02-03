import { pathToFileURL } from "url"
import { resolve, join, isAbsolute, dirname } from "path"
import { mkdirSync, existsSync } from "fs"
import { readFile, writeFile, rm, readdir } from "fs/promises"
import { createHash } from "crypto"

import type { BunPlugin, Loader } from "bun"

import { Logger } from "./logging/logger"
import { lecticCacheDir } from "./utils/xdg"

const REMOTE_HTTP_PLUGIN_VERSION = "v2"
const SCRIPT_CACHE_VERSION = 5

type ScriptCacheManifestV5 = {
    version: 5
    bunVersion: string
    pluginVersion: string
    scriptPath: string
    entryHash: string
    builtEntrypoint: string
    outputFiles: string[]
    inputHashes: Record<string, string>
    remoteInputs: string[]
}

type ScriptCacheManifest = ScriptCacheManifestV5

function usage(): string {
    return (
        "usage: lectic script <module-path> [args...]\n"
        + "\n"
        + "Runs a JS/TS/JSX/TSX module as a script. Top-level code runs on\n"
        + "import. If the module exports a default function, it will be\n"
        + "called. Script args are available via process.argv.\n"
        + "\n"
        + "Remote HTTPS imports are supported during bundling.\n"
        + "\n"
        + "Note: for TSX/JSX using React's automatic runtime, Lectic will\n"
        + "rewrite react/jsx-runtime imports based on your React URL import\n"
        + "(e.g. import React from \"https://esm.sh/react\").\n"
    )
}

function sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex")
}

async function sha256File(path: string): Promise<string> {
    return sha256(await readFile(path, "utf8"))
}

function inferLoader(url: string, contentType: string | null): Loader {
    const pathname = (() => {
        try {
            return new URL(url).pathname
        } catch {
            return url
        }
    })()

    if (pathname.endsWith(".tsx")) return "tsx"
    if (pathname.endsWith(".ts")) return "ts"
    if (pathname.endsWith(".jsx")) return "jsx"
    if (pathname.endsWith(".js")) return "js"
    // Treat WASM as a file asset by default. Some packages expect the
    // `.wasm` to exist on disk and do `import.meta.resolve("./x.wasm")`.
    if (pathname.endsWith(".wasm")) return "file"

    if (contentType?.includes("typescript")) return "ts"
    if (contentType?.includes("application/wasm")) return "file"
    return "js"
}

function findReactImportUrl(entrySource: string): URL | null {
    // Keep this intentionally simple: the intended use case is a self-contained
    // script that explicitly imports React from a URL.
    const m = entrySource.match(
        /\bimport\s+(?:\*\s+as\s+)?React(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/
    )

    if (!m) return null

    const spec = m[1]
    if (!spec) return null

    try {
        const u = new URL(spec)
        if (u.protocol !== "https:" && u.protocol !== "http:") {
            return null
        }
        return u
    } catch {
        return null
    }
}

function withPathSuffix(base: URL, suffix: string): string {
    const u = new URL(base.href)
    u.pathname = u.pathname.replace(/\/+$/, "") + `/${suffix}`
    return u.href
}

function reactJsxRuntimeUrlPlugin(entrySource: string): BunPlugin {
    const reactImportUrl = findReactImportUrl(entrySource)

    return {
        name: "react-jsx-runtime-url",
        setup(build) {
            if (!reactImportUrl) return

            build.onResolve(
                { filter: /^react\/jsx-(dev-)?runtime$/ },
                (args) => {
                    const isDev = args.path.includes("jsx-dev-runtime")
                    const url = withPathSuffix(
                        reactImportUrl,
                        isDev ? "jsx-dev-runtime" : "jsx-runtime"
                    )
                    return { path: url, namespace: "remote-http" }
                }
            )
        },
    }
}

function isLocalhostHttp(u: URL): boolean {
    return (
        u.protocol === "http:"
        && (u.hostname === "localhost"
            || u.hostname === "127.0.0.1"
            || u.hostname === "::1")
    )
}

function remoteHttpPlugin(): BunPlugin {
    return {
        name: `remote-http-${REMOTE_HTTP_PLUGIN_VERSION}`,
        setup(build) {
            const ns = "remote-http"
            const memo = new Map<
                string,
                Promise<{ contents: string | Uint8Array, loader: Loader }>
            >()

            build.onResolve({ filter: /^https?:\/\// }, (args) => {
                return { path: args.path, namespace: ns }
            })

            build.onResolve(
                { filter: /^(\.{0,2}\/|\/)/ },
                (args) => {
                    const importer = args.importer

                    const isRemoteImporter = importer.startsWith("http://")
                        || importer.startsWith("https://")
                        || args.namespace === ns

                    if (!isRemoteImporter) return

                    return {
                        path: new URL(args.path, importer).href,
                        namespace: ns,
                    }
                }
            )

            build.onLoad({ filter: /.*/, namespace: ns }, async (args) => {
                const url = args.path
                const body = memo.get(url)
                    ?? (async () => {
                        const parsed = new URL(url)
                        if (
                            parsed.protocol === "http:"
                            && !isLocalhostHttp(parsed)
                        ) {
                            throw new Error(
                                "only https:// imports are supported"
                            )
                        }

                        const res = await fetch(url)
                        if (!res.ok) {
                            throw new Error(
                                `failed to fetch ${url}: ${res.status} `
                                + `${res.statusText}`
                            )
                        }

                        const contentType = res.headers.get("content-type")
                        const loader = inferLoader(url, contentType)

                        if (loader === "file") {
                            const buf = new Uint8Array(
                                await res.arrayBuffer()
                            )
                            return { contents: buf, loader }
                        }

                        return {
                            contents: await res.text(),
                            loader,
                        }
                    })()

                memo.set(url, body)

                return body
            })
        },
    }
}

function normalizeInputPath(p: string, baseDir: string): string {
    if (p.startsWith("http://") || p.startsWith("https://")) return p
    if (isAbsolute(p)) return p
    return resolve(baseDir, p)
}

async function readManifest(
    path: string
): Promise<ScriptCacheManifest | null> {
    try {
        const raw = await readFile(path, "utf8")
        const parsed = JSON.parse(raw)
        if (parsed && parsed.version === 5) {
            return parsed as ScriptCacheManifest
        }
        return null
    } catch {
        return null
    }
}

async function isCacheValid(
    manifest: ScriptCacheManifest,
    expectedEntryHash: string
): Promise<boolean> {
    if (manifest.version !== SCRIPT_CACHE_VERSION) return false
    if (manifest.entryHash !== expectedEntryHash) return false
    if (manifest.bunVersion !== Bun.version) return false
    if (manifest.pluginVersion !== REMOTE_HTTP_PLUGIN_VERSION) return false

    for (const out of manifest.outputFiles) {
        if (!existsSync(out)) return false
    }

    if (!existsSync(manifest.builtEntrypoint)) return false

    for (const [path, expectedHash] of Object.entries(manifest.inputHashes)) {
        if (path.startsWith("http://") || path.startsWith("https://")) {
            continue
        }
        if (!existsSync(path)) return false
        const actual = await sha256File(path)
        if (actual !== expectedHash) return false
    }

    return true
}

function formatBuildException(e: unknown): string {
    const messageFrom = (x: unknown): string | null => {
        if (!x || typeof x !== "object") return null
        if (!("message" in x)) return null

        const msg = (x as { message?: unknown }).message
        return typeof msg === "string" ? msg : null
    }

    if (e instanceof AggregateError) {
        const parts = e.errors.map((err) => {
            const msg = messageFrom(err)
            if (msg) return msg
            return typeof err === "string" ? err : JSON.stringify(err)
        })

        const body = parts.filter(Boolean).join("\n")
        return body.length > 0 ? body : String(e)
    }

    if (e instanceof Error) return e.stack ?? e.message
    return String(e)
}

type MissingModule = {
    specifier: string
    from: string
}

function parseMissingModuleError(msg: string): MissingModule | null {
    const m = msg.match(/Cannot find module '([^']+)' from '([^']+)'/)
    if (!m) return null

    const specifier = m[1]
    const from = m[2]

    if (!specifier || !from) return null

    return { specifier, from }
}

async function printMissingAssetHints(opt: {
    cacheDir: string
    missing: MissingModule
}): Promise<void> {
    const { specifier } = opt.missing

    // For remote imports, missing modules are often non-JS assets referenced
    // via import.meta.resolve() / new URL() / dynamic resolution.
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        return
    }

    const manifest = await readManifest(join(opt.cacheDir, "manifest.json"))
    if (!manifest) return

    if (manifest.remoteInputs.length === 0) {
        return
    }

    await Logger.write(`hint: missing runtime module ${specifier}\n`)
    await Logger.write(
        "hint: when using https:// imports, non-js/ts assets might not be bundled "
        + "automatically.\n"
    )
    await Logger.write(
        "hint: try adding an explicit https:// import for the missing asset "
        + "to force it into the script cache directory.\n"
    )

    await Logger.write("hint: remote module inputs for this bundle:\n")
    for (const u of manifest.remoteInputs.slice(0, 12)) {
        await Logger.write(`  - ${u}\n`)
    }

    await Logger.write("hint: candidate URLs to try:\n")

    const seen = new Set<string>()

    for (const u of manifest.remoteInputs) {
        try {
            const base = new URL(u)
            base.pathname = dirname(base.pathname) + "/"
            const candidate = new URL(specifier, base.href).href
            if (seen.has(candidate)) continue
            seen.add(candidate)

            await Logger.write(`  - ${candidate}\n`)

            if (seen.size >= 12) break
        } catch {
            // Ignore.
        }
    }
}

function formatBuildLogs(result: Awaited<ReturnType<typeof Bun.build>>): string {
    const logs = result.logs
    if (!logs || logs.length === 0) return ""

    const format = (log: unknown): string => {
        if (typeof log === "string") return log
        if (!log || typeof log !== "object") return String(log)

        const msg = (log as { message?: unknown }).message
        if (typeof msg === "string") return msg

        try {
            return JSON.stringify(log)
        } catch {
            return String(log)
        }
    }

    return logs.map(format).join("\n")
}

async function buildScript(opt: {
    scriptPath: string
    entrySource: string
    entryHash: string
    cacheDir: string
    invocationCwd: string
}): Promise<string> {
    const cacheRoot = dirname(opt.cacheDir)
    mkdirSync(cacheRoot, { recursive: true })

    const tmpDir = join(
        cacheRoot,
        `.tmp-${opt.entryHash}-${process.pid}-${Date.now()}`
    )

    mkdirSync(tmpDir, { recursive: true })

    let result: Awaited<ReturnType<typeof Bun.build>>

    try {
        result = await Bun.build({
            entrypoints: [opt.scriptPath],
            outdir: tmpDir,
            format: "esm",
            target: "bun",
            splitting: false,
            sourcemap: "inline",
            loader: {
                // Use file loader so WASM assets can exist on disk and be
                // resolved via import.meta.resolve("./x.wasm") at runtime.
                ".wasm": "file",
            },
            naming: {
                entry: "entry.js",
                chunk: "chunk-[name].[ext]",
                // Some libs resolve hard-coded paths, e.g. "./yoga.wasm"
                // relative to the bundle, so we keep original basenames.
                asset: "[name].[ext]",
            },
            metafile: true,
            plugins: [
                reactJsxRuntimeUrlPlugin(opt.entrySource),
                remoteHttpPlugin(),
            ],
        })
    } catch (e) {
        await rm(tmpDir, { recursive: true, force: true })
        throw new Error(`Bundle failed\n${formatBuildException(e)}`)
    }

    if (!result.success) {
        const logs = formatBuildLogs(result)
        await rm(tmpDir, { recursive: true, force: true })
        throw new Error(`Bundle failed\n${logs}`)
    }

    const metafile = result.metafile
    const inputs = metafile ? Object.keys(metafile.inputs) : []

    const inputHashes: Record<string, string> = {}
    for (const input of inputs) {
        const normalized = normalizeInputPath(input, opt.invocationCwd)
        if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
            continue
        }

        if (!existsSync(normalized)) {
            continue
        }

        inputHashes[normalized] = await sha256File(normalized)
    }

    const listFiles = async (dir: string): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true })
        const out: string[] = []

        for (const ent of entries) {
            const rel = ent.name
            const abs = join(dir, ent.name)

            if (ent.isDirectory()) {
                for (const child of await listFiles(abs)) {
                    out.push(join(rel, child))
                }
            } else if (ent.isFile()) {
                out.push(rel)
            }
        }

        return out
    }

    const relOutputs = await listFiles(tmpDir)
    const outputFiles = relOutputs.map((p) => join(opt.cacheDir, p))

    const builtEntrypointOut = join(opt.cacheDir, "entry.js")

    const remoteInputs = inputs.filter((p) => {
        return p.startsWith("http://") || p.startsWith("https://")
    })

    const manifest: ScriptCacheManifest = {
        version: 5,
        bunVersion: Bun.version,
        pluginVersion: REMOTE_HTTP_PLUGIN_VERSION,
        scriptPath: opt.scriptPath,
        entryHash: opt.entryHash,
        builtEntrypoint: builtEntrypointOut,
        outputFiles,
        inputHashes,
        remoteInputs,
    }

    try {
        await rm(opt.cacheDir, { recursive: true, force: true })
        mkdirSync(opt.cacheDir, { recursive: true })

        for (const rel of relOutputs) {
            const src = join(tmpDir, rel)
            const dst = join(opt.cacheDir, rel)

            mkdirSync(dirname(dst), { recursive: true })
            await Bun.write(dst, Bun.file(src))
        }

        await writeFile(
            join(opt.cacheDir, "manifest.json"),
            JSON.stringify(manifest, null, 2),
            "utf8"
        )
    } finally {
        await rm(tmpDir, { recursive: true, force: true })
    }

    return manifest.builtEntrypoint
}

export async function scriptCmd(args: string[]): Promise<number> {
    if (
        args.length === 0
        || (args.length === 1 && (args[0] === "-h" || args[0] === "--help"))
    ) {
        if (args.length === 0) {
            await Logger.write("error: script requires a module path\n")
        }
        await Logger.write(usage())
        return args.length === 0 ? 1 : 0
    }

    const invocationCwd = process.cwd()

    const scriptPath = resolve(invocationCwd, args[0])

    let entrySource: string
    try {
        entrySource = await readFile(scriptPath, "utf8")
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await Logger.write(
            `error: failed to read script '${scriptPath}': ${msg}\n${usage()}`
        )
        return 1
    }

    const entryHash = sha256(
        [
            `cache-version:${SCRIPT_CACHE_VERSION}`,
            `bun:${Bun.version}`,
            `plugin:${REMOTE_HTTP_PLUGIN_VERSION}`,
            `path:${scriptPath}`, 
            //path is needed since the script might reference other files in
            //the same directory, and those paths get baked into the bundle
            `entry:${entrySource}`,
        ].join("\n")
    )

    const cacheDir = join(lecticCacheDir(), "scripts", entryHash)
    const manifestPath = join(cacheDir, "manifest.json")

    let builtEntrypoint: string

    const manifest = await readManifest(manifestPath)
    if (manifest && (await isCacheValid(manifest, entryHash))) {
        builtEntrypoint = manifest.builtEntrypoint
    } else {
        try {
            builtEntrypoint = await buildScript({
                scriptPath,
                entrySource,
                entryHash,
                cacheDir,
                invocationCwd,
            })
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            await Logger.write(
                `error: failed to bundle script '${scriptPath}': ${msg}\n`
                + "note: remote imports must be explicit https:// URLs\n"
                + "      (http:// is allowed only for localhost).\n"
            )
            return 1
        }
    }

    const originalArgv = process.argv

    try {
        process.argv = [
            process.argv[0] || "bun",
            scriptPath,
            ...args.slice(1),
        ]

        const modUrl = pathToFileURL(builtEntrypoint).href

        let mod: unknown
        try {
            mod = await import(modUrl)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            await Logger.write(
                `error: failed to run script module '${scriptPath}': ${msg}\n`
            )

            const missing = parseMissingModuleError(msg)
            if (missing) {
                await printMissingAssetHints({ cacheDir, missing })
            }

            return 1
        }

        const entryFn = (mod as Record<string, unknown>)["default"]

        if (typeof entryFn === "function") {
            try {
                await Promise.resolve(entryFn())
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                await Logger.write(
                    `error: script default function threw: ${msg}\n`
                )
                return 1
            }
        }

        return 0
    } finally {
        process.argv = originalArgv
    }
}
