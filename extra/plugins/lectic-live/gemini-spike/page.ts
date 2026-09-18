export const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lectic Gemini stage 1 spike</title>
<link rel="stylesheet" href="/style.css"></head><body>
<h1>Gemini Live: stage 1 spike</h1>
<p><strong>{{mode}}</strong></p>
<p>Experimental paid test, not normal Lectic Live. The default backend is a
20-second simulation. Real mode requires approving a specific request below.
Closing this page stops local work, not actions already performed.</p>
<p>Microphone audio goes to Google. No local audio recording. The provider's
retention terms apply. Maximum connected time is five minutes, not a spending
cap. No reconnection or automatic retry.</p>
<label>Requested AudioContext rate
<select id="rate"><option value="0">Native default</option>
<option value="44100">44,100 Hz</option>
<option value="48000">48,000 Hz</option></select></label>
<button id="start">Start paid microphone test</button>
<button id="stop">Stop</button>
<p id="status">No paid connection yet</p>
<section id="approvals" aria-label="Real request authorization"></section>
<h2>Normal transcripts (private, memory only)</h2>
<p>Exact fragments, JSON-escaped, in local receipt order. No inferred media
clock or finality. Only the most recent 200 fragments are displayed. Do not
share private transcript text. Transcript text is excluded from export.</p>
<div id="transcript" class="log"></div>
<h2>Redacted trace</h2>
<button id="export">Download redacted event sequence</button>
<p>Contains rates, receipt order, call aliases and latest token counters,
not task text, transcripts, raw provider IDs, credentials or audio.
Only the latest 2,000 records are exported. Sends are not acknowledgments.</p>
<div id="trace" class="log"></div>
<script src="/browser.js" defer></script></body></html>`

export const style = `body {
  max-width: 64rem; margin: 2rem auto; padding: 0 1rem;
  color: #111; background: #fff; font: 16px/1.5 system-ui;
}
button, select { font: inherit; margin: .3rem; padding: .4rem; }
.log { max-height: 18rem; overflow: auto; border: 1px solid #aaa;
  padding: .5rem; font: 13px/1.5 monospace; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
#status { font-weight: bold; }
`
