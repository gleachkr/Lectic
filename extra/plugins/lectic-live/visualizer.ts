// Radial bars adapted from https://github.com/Roy-05/audio-visualizer.
// Keep the upstream notice in the embedded browser bundle as well.
export const visualizerLicense = `/*
MIT License
Copyright (c) 2020 Saket Roy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/`

// Self-contained for embedding: do not capture module-level runtime values.
export function createVisualizer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")
  let audioContext: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let analyser: AnalyserNode | undefined
  const frequencies = new Uint8Array(512)
  let frame = 0
  let stopped = false
  let dim = 0

  function draw() {
    if (!ctx) return
    const size = canvas.getBoundingClientRect().width
    const pixels = Math.max(1, Math.round(size * devicePixelRatio))
    if (canvas.width !== pixels || canvas.height !== pixels) {
      canvas.width = pixels
      canvas.height = pixels
    }
    // Reference proportions: radius 140, max height 160, 150 rounded bars.
    ctx.setTransform(pixels / 640, 0, 0, pixels / 640, 0, 0)
    ctx.clearRect(0, 0, 640, 640)
    frequencies.fill(0)
    if (!stopped && audioContext?.state === "running") {
      analyser?.getByteFrequencyData(frequencies)
    }
    const gray = Math.round(dim * 170)
    ctx.strokeStyle = dim === 0 ? "#000" : `rgb(${gray}, ${gray}, ${gray})`
    ctx.lineWidth = 2
    ctx.lineCap = "round"
    ctx.beginPath()
    for (let i = 0; i < 150; i++) {
      const angle = Math.PI + i * 2 * Math.PI / 150
      const height = Math.max(5, frequencies[i] / 255 * 160)
      const x = Math.cos(angle)
      const y = Math.sin(angle)
      ctx.moveTo(320 + x * 140, 320 + y * 140)
      ctx.lineTo(320 + x * (140 + height), 320 + y * (140 + height))
    }
    ctx.stroke()
  }
  function animate() {
    draw()
    if (!stopped) frame = requestAnimationFrame(animate)
  }
  function resume() {
    if (stopped || !audioContext) return
    if (audioContext.state !== "running") {
      console.log("Lectic Live: audio visualization suspended; "
        + "click anywhere or press a key to enable it.")
      void audioContext.resume().catch(() => {
        console.log("Lectic Live: audio visualization could not resume.")
      })
    }
  }
  window.addEventListener("resize", draw)
  animate()
  return {
    dim(value: number) { dim = Math.max(0, Math.min(1, value)) },
    detach() {
      source?.disconnect()
      analyser?.disconnect()
      source = undefined
      analyser = undefined
      draw()
    },
    attach(stream: MediaStream) {
      if (stopped) return
      try {
        audioContext ??= new AudioContext()
        analyser ??= audioContext.createAnalyser()
        analyser.fftSize = 1024
        analyser.minDecibels = -90
        analyser.maxDecibels = -10
        analyser.smoothingTimeConstant = 0.88
        source?.disconnect()
        source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)
        // Analysis only: the audio element is the sole playback path.
        // Never connect the microphone or this graph to the destination.
        resume()
      } catch {
        console.log("Lectic Live: audio visualization unavailable.")
      }
    },
    resume,
    stop() {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", draw)
      source?.disconnect()
      analyser?.disconnect()
      void audioContext?.close().catch(() => {})
      draw()
    },
  }
}
