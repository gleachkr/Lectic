export async function readStream(
    rs: ReadableStream<Uint8Array> | null,
    sink: (s: string) => void,
) {
    if (!rs) return
    const reader = rs.getReader()
    const td = new TextDecoder()
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
                const decoded = td.decode(value, { stream: true })
                if (decoded.length > 0) sink(decoded)
            }
        }
        const final = td.decode()
        if (final.length > 0) sink(final)
    } finally {
        reader.releaseLock()
    }
}
