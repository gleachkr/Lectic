import { lecticEnv } from "../utils/xdg";

export function expandEnv(target : string, extra?: Record<string, string>) : string {

    const env : Record<string, string | undefined> = { ...process.env, ...lecticEnv, ...(extra ?? {}) }

    const varRe = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g

    return target.replace(varRe, (match, braced, bare) => {
      const name = braced ?? bare
      const val = env[name]
      return val !== undefined ? String(val) : match
    })
}
