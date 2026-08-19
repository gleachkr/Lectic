import { expect, it } from "bun:test"

import { readStream } from "./stream"

it("preserves UTF-8 characters split across stream chunks", async () => {
  const encoded = new TextEncoder().encode("A😀B")
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, 3))
      controller.enqueue(encoded.slice(3, 5))
      controller.enqueue(encoded.slice(5))
      controller.close()
    },
  })

  let output = ""
  await readStream(stream, (chunk) => {
    output += chunk
  })

  expect(output).toBe("A😀B")
})
