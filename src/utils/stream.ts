export async function readStream(rs: ReadableStream<Uint8Array> | null, sink: (s: string) => void) {
    if (!rs) return
    const reader = rs.getReader()
    const td = new TextDecoder()
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) sink(td.decode(value))
        }
    } finally {
        reader.releaseLock()
    }
}
