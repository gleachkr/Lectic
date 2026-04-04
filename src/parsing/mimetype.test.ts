import { describe, it, expect } from "bun:test"
import { detectMimetype, detectMimetypeFromBytes } from "./mimetype"

describe("detectMimetype", () => {
  it("returns text/plain for plain text", () => {
    expect(detectMimetype("hello world")).toBe("text/plain")
  })

  it("returns text/plain for empty string", () => {
    expect(detectMimetype("")).toBe("text/plain")
  })

  it("detects JSON objects", () => {
    expect(detectMimetype('{"key": "value"}')).toBe("application/json")
  })

  it("detects JSON arrays", () => {
    expect(detectMimetype('[1, 2, 3]')).toBe("application/json")
  })

  it("returns text/plain for invalid JSON starting with {", () => {
    expect(detectMimetype("{not json at all")).toBe("text/plain")
  })

  it("detects HTML with doctype", () => {
    expect(detectMimetype("<!DOCTYPE html><html></html>")).toBe("text/html")
  })

  it("detects HTML with html tag", () => {
    expect(detectMimetype("<html>\n<body></body>\n</html>")).toBe("text/html")
  })

  it("detects SVG", () => {
    expect(detectMimetype('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(
      "image/svg+xml"
    )
  })

  it("detects XML", () => {
    expect(detectMimetype('<?xml version="1.0"?><root/>')).toBe(
      "application/xml"
    )
  })

  it("detects base64-encoded PNG", () => {
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const b64 = Buffer.from(pngBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("image/png")
  })

  it("detects base64-encoded JPEG", () => {
    // JPEG magic bytes: FF D8 FF E0
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const b64 = Buffer.from(jpegBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("image/jpeg")
  })

  it("detects base64-encoded GIF", () => {
    // GIF87a
    const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    const b64 = Buffer.from(gifBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("image/gif")
  })

  it("detects base64-encoded PDF", () => {
    // %PDF
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e])
    const b64 = Buffer.from(pdfBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("application/pdf")
  })

  it("detects base64-encoded WebP", () => {
    // RIFF....WEBP
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ])
    const b64 = Buffer.from(webpBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("image/webp")
  })

  // --- Audio formats ---

  it("detects base64-encoded WAV", () => {
    // RIFF....WAVE
    const wavBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ])
    const b64 = Buffer.from(wavBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("audio/wav")
  })

  it("detects base64-encoded MP3 with ID3 tag", () => {
    // ID3 header
    const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00])
    const b64 = Buffer.from(mp3Bytes).toString("base64")
    expect(detectMimetype(b64)).toBe("audio/mp3")
  })

  it("detects base64-encoded MP3 frame sync", () => {
    const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
    const b64 = Buffer.from(mp3Bytes).toString("base64")
    expect(detectMimetype(b64)).toBe("audio/mp3")
  })

  it("detects base64-encoded FLAC", () => {
    // fLaC
    const flacBytes = new Uint8Array([0x66, 0x4c, 0x61, 0x43])
    const b64 = Buffer.from(flacBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("audio/flac")
  })

  it("detects base64-encoded OGG", () => {
    // OggS
    const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53])
    const b64 = Buffer.from(oggBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("audio/ogg")
  })

  // --- Video formats ---

  it("detects base64-encoded WebM", () => {
    // EBML header: 1A 45 DF A3
    const webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
    const b64 = Buffer.from(webmBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("video/webm")
  })

  it("detects base64-encoded AVI", () => {
    // RIFF....AVI<space>
    const aviBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20,
    ])
    const b64 = Buffer.from(aviBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("video/avi")
  })

  it("detects base64-encoded MP4 (isom brand)", () => {
    // ftyp box: size(4) + "ftyp" + "isom"
    const mp4Bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x14, // box size
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x69, 0x73, 0x6f, 0x6d, // "isom"
    ])
    const b64 = Buffer.from(mp4Bytes).toString("base64")
    expect(detectMimetype(b64)).toBe("video/mp4")
  })

  it("detects base64-encoded HEIC", () => {
    const heicBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x68, 0x65, 0x69, 0x63, // "heic"
    ])
    const b64 = Buffer.from(heicBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("image/heic")
  })

  it("detects base64-encoded HEIF (mif1 brand)", () => {
    const heifBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x6d, 0x69, 0x66, 0x31, // "mif1"
    ])
    const b64 = Buffer.from(heifBytes).toString("base64")
    expect(detectMimetype(b64)).toBe("image/heif")
  })

  it("detects base64-encoded 3GPP", () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x14,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x33, 0x67, 0x70, 0x34, // "3gp4"
    ])
    const b64 = Buffer.from(bytes).toString("base64")
    expect(detectMimetype(b64)).toBe("video/3gpp")
  })

  it("detects base64-encoded M4A audio", () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x4d, 0x34, 0x41, 0x20, // "M4A "
    ])
    const b64 = Buffer.from(bytes).toString("base64")
    expect(detectMimetype(b64)).toBe("audio/x-m4a")
  })

  // --- Fallbacks ---

  it("returns text/plain for short strings that look vaguely base64", () => {
    // "abc" is valid base64 but too short / no magic bytes
    expect(detectMimetype("abc")).toBe("text/plain")
  })

  it("returns text/plain for normal text that could be base64", () => {
    // "Hello World" has spaces so it won't match base64 regex
    expect(detectMimetype("Hello World")).toBe("text/plain")
  })
})

describe("detectMimetypeFromBytes", () => {
  it("detects PNG from raw bytes", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(detectMimetypeFromBytes(bytes)).toBe("image/png")
  })

  it("detects JPEG from raw bytes", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(detectMimetypeFromBytes(bytes)).toBe("image/jpeg")
  })

  it("detects MP4 from raw bytes", () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x14,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
    ])
    expect(detectMimetypeFromBytes(bytes)).toBe("video/mp4")
  })

  it("returns application/octet-stream for unknown bytes containing nulls", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00])
    expect(detectMimetypeFromBytes(bytes)).toBe("application/octet-stream")
  })

  it("returns text/plain for unknown bytes without nulls", () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])
    expect(detectMimetypeFromBytes(bytes)).toBe("text/plain")
  })

  it("returns text/plain for too-short input without nulls", () => {
    expect(detectMimetypeFromBytes(new Uint8Array([0x89, 0x50]))).toBe("text/plain")
  })
})
