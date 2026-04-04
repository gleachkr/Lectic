// Best-effort mimetype detection from string content.
// Falls back to "text/plain" when nothing more specific is detected.

const BASE64_RE = /^[A-Za-z0-9+/\n\r]+=*$/

// Minimum length to bother trying binary detection (a few base64 chars
// is enough to decode 3+ raw bytes for magic-byte checks).
const MIN_BASE64_LEN = 8

/**
 * Try to detect the mimetype of `content` using simple heuristics.
 *
 * Text-based formats are detected by leading syntax. Binary formats
 * are detected by base64-decoding the first chunk and checking magic
 * bytes.  Returns "text/plain" when nothing matches.
 */
export function detectMimetype(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length === 0) return "text/plain"

  // --- Text-based formats ---

  if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return "text/html"
  }

  if (/^<svg[\s>]/i.test(trimmed)) {
    return "image/svg+xml"
  }

  if (/^<\?xml[\s]/i.test(trimmed)) {
    return "application/xml"
  }

  // JSON: starts with { or [ and parses successfully
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      JSON.parse(trimmed)
      return "application/json"
    } catch { /* not JSON */ }
  }

  // --- Base64-encoded binary formats ---
  if (trimmed.length >= MIN_BASE64_LEN && BASE64_RE.test(trimmed)) {
    const detected = detectFromBase64(trimmed)
    if (detected) return detected
  }

  return "text/plain"
}

function detectFromBase64(b64: string): string | null {
  // Decode enough bytes to check all magic signatures.  We grab the
  // first 24 base64 chars (→ up to 18 raw bytes), which is enough for
  // every signature we inspect.
  const chunk = b64.replace(/[\n\r]/g, "").slice(0, 24)
  let bytes: Uint8Array
  try {
    bytes = Buffer.from(chunk, "base64")
  } catch {
    return null
  }
  return detectMimetypeFromBytes(bytes)
}

/**
 * Detect a mimetype from raw bytes.  Checks magic-byte signatures
 * first, then falls back to Bun's extension-based lookup when a
 * `filename` is provided.  Always returns a backend-ready mimetype:
 * text subtypes are normalized to "text/plain" and truly unknown
 * binary content returns "application/octet-stream".
 */
export function detectMimetypeFromBytes(
  bytes: Uint8Array,
  filename?: string,
): string {
  const fromMagic = detectFromMagicBytes(bytes)
  if (fromMagic) return fromMagic

  if (filename) {
    const extType = Bun.file(filename).type
    if (extType !== "application/octet-stream") {
      return extType.replace(/^text\/.+$/, "text/plain")
    }
  }

  // No magic bytes matched and the extension didn't help.  If the
  // content contains no null bytes it is likely text, not binary.
  if (bytes.find(b => b === 0x00) === undefined) return "text/plain"

  return "application/octet-stream"
}

function detectFromMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null

  // --- Images ---

  // PNG: 89 50 4E 47
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png"
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }

  // GIF: GIF87a or GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif"
  }

  // RIFF container — branch on the format tag at bytes 8-11
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 12
  ) {
    // WebP: RIFF....WEBP
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp"
    }
    // WAV: RIFF....WAVE
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    ) {
      return "audio/wav"
    }
    // AVI: RIFF....AVI
    if (
      bytes[8] === 0x41 &&
      bytes[9] === 0x56 &&
      bytes[10] === 0x49 &&
      bytes[11] === 0x20
    ) {
      return "video/avi"
    }
  }

  // --- Documents ---

  // PDF: %PDF
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "application/pdf"
  }

  // --- Audio ---

  // FLAC: fLaC
  if (
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    return "audio/flac"
  }

  // OGG: OggS
  if (
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return "audio/ogg"
  }

  // MP3: ID3 tag header
  if (
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return "audio/mp3"
  }

  // MP3: frame sync (no ID3 tag)
  if (
    bytes[0] === 0xff &&
    (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2)
  ) {
    return "audio/mp3"
  }

  // --- Video ---

  // WebM / Matroska: EBML header 1A 45 DF A3
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm"
  }

  // ftyp-based formats (MP4, HEIC/HEIF).  The ftyp box can start at
  // byte 4 (the first 4 bytes are the box length).
  if (bytes.length >= 12 && isFtyp(bytes)) {
    return detectFtyp(bytes)
  }

  return null
}

// Check for "ftyp" at offset 4
function isFtyp(b: Uint8Array): boolean {
  return (
    b[4] === 0x66 && // f
    b[5] === 0x74 && // t
    b[6] === 0x79 && // y
    b[7] === 0x70    // p
  )
}

// Read the 4-byte major brand at offset 8 and return the mimetype.
function detectFtyp(b: Uint8Array): string | null {
  const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
  switch (brand) {
    case "heic":
    case "heix":
      return "image/heic"
    case "mif1":
    case "msf1":
    case "hevc":
    case "hevx":
      return "image/heif"
    case "isom":
    case "iso2":
    case "mp41":
    case "mp42":
    case "M4V ":
    case "avc1":
    case "dash":
      return "video/mp4"
    case "M4A ":
      return "audio/x-m4a"
    case "3gp4":
    case "3gp5":
    case "3gp6":
    case "3ge6":
    case "3ge7":
    case "3gg6":
      return "video/3gpp"
    default:
      // Unknown ftyp brand — MP4 is the safest generic guess
      return "video/mp4"
  }
}
