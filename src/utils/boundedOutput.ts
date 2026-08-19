export type BoundedTextResult = {
  text: string
  truncated: boolean
  originalCharacters: number
  returnedCharacters: number
  originalLines: number
  returnedLines: number
  headCharacters: number
  tailCharacters: number
}

function countLines(chars: string[]): number {
  if (chars.length === 0) return 0

  let lines = 0
  for (const char of chars) {
    if (char === "\n") lines++
  }
  if (chars[chars.length - 1] !== "\n") lines++
  return lines
}

/**
 * Retains enough of a stream to later render any head-and-tail view up to
 * maxCharacters. Memory use remains bounded regardless of stream size.
 */
export class BoundedTextCollector {
  private readonly headCapacity: number
  private readonly tailCapacity: number
  private complete: string[] | null = []
  private head: string[] = []
  private tail: string[] = []
  private characters = 0
  private lines = 0
  private lastCharacter: string | undefined

  constructor(readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 0) {
      throw new Error("maxCharacters must be a non-negative integer")
    }

    this.headCapacity = Math.ceil(maxCharacters / 2)
    this.tailCapacity = Math.floor(maxCharacters / 2)
  }

  append(chunk: string): void {
    if (chunk.length === 0) return

    const chars = [...chunk]
    this.characters += chars.length
    for (const char of chars) {
      if (char === "\n") this.lines++
    }
    this.lastCharacter = chars[chars.length - 1]

    if (this.complete !== null) {
      if (this.complete.length + chars.length <= this.maxCharacters) {
        this.complete = this.complete.concat(chars)
      } else {
        this.complete = null
      }
    }

    if (this.head.length < this.headCapacity) {
      const needed = this.headCapacity - this.head.length
      this.head = this.head.concat(chars.slice(0, needed))
    }

    if (this.tailCapacity > 0) {
      if (chars.length >= this.tailCapacity) {
        this.tail = chars.slice(-this.tailCapacity)
      } else {
        this.tail = this.tail.concat(chars)
        if (this.tail.length > this.tailCapacity) {
          this.tail = this.tail.slice(-this.tailCapacity)
        }
      }
    }
  }

  get length(): number {
    return this.characters
  }

  render(maxCharacters: number): BoundedTextResult {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 0) {
      throw new Error("maxCharacters must be a non-negative integer")
    }
    if (maxCharacters > this.maxCharacters) {
      throw new Error("maxCharacters exceeds the collector capacity")
    }

    const originalLines = this.characters === 0
      ? 0
      : this.lines + (this.lastCharacter === "\n" ? 0 : 1)

    if (this.complete !== null && this.characters <= maxCharacters) {
      const text = this.complete.join("")
      return {
        text,
        truncated: false,
        originalCharacters: this.characters,
        returnedCharacters: this.characters,
        originalLines,
        returnedLines: originalLines,
        headCharacters: this.characters,
        tailCharacters: 0,
      }
    }

    const headCharacters = Math.ceil(maxCharacters / 2)
    const tailCharacters = Math.floor(maxCharacters / 2)
    const sourceHead = this.complete ?? this.head
    const sourceTail = this.complete ?? this.tail
    const returned = [
      ...sourceHead.slice(0, headCharacters),
      ...(tailCharacters > 0 ? sourceTail.slice(-tailCharacters) : []),
    ]
    const text = returned.join("")

    return {
      text,
      truncated: this.characters > returned.length,
      originalCharacters: this.characters,
      returnedCharacters: returned.length,
      originalLines,
      returnedLines: countLines(returned),
      headCharacters: Math.min(headCharacters, returned.length),
      tailCharacters: Math.min(
        tailCharacters,
        Math.max(0, returned.length - headCharacters),
      ),
    }
  }
}

export function allocateOutputBudgets(
  limit: number,
  stdoutCharacters: number,
  stderrCharacters: number,
): { stdout: number; stderr: number } {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("limit must be a non-negative integer")
  }

  const stderrReserve = Math.floor(limit / 4)
  let stderr = Math.min(stderrCharacters, stderrReserve)
  let stdout = Math.min(stdoutCharacters, limit - stderr)
  let remaining = limit - stdout - stderr

  if (remaining > 0) {
    const extraStderr = Math.min(stderrCharacters - stderr, remaining)
    stderr += extraStderr
    remaining -= extraStderr
  }

  if (remaining > 0) {
    stdout += Math.min(stdoutCharacters - stdout, remaining)
  }

  return { stdout, stderr }
}
