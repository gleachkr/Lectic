type NativeTool = "search" | "code"

export type NativeToolSpec = {
    native: NativeTool
}

export function isNativeTool(raw : unknown) : raw is NativeToolSpec {
    return raw !== null 
        && typeof raw === "object" 
        && "native" in raw
        && (raw.native === "search" || raw.native === "code")
}
