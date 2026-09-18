# Lectic Live

A local speech interface to Lectic. GPT-Live handles the conversation and
asks your configured Lectic backend for tools, actions, or deeper reasoning.
Greetings and ordinary conversation do not independently run Lectic. You
can keep speaking while backend work runs. Gemini is also available with
**delegation and microphone wake** after idle or recoverable loss. Production
Gemini delegation is offline-tested; browser acceptance remains pending.
Saved-history CLI resume for Gemini is not yet enabled.

## Setup

You need:

- A POSIX host and Lectic on PATH with `--no-macros` support.
- A browser with microphone permission and audio output. OpenAI uses WebRTC;
  Gemini needs AudioWorklet and WebAudio support.
- `OPENAI_API_KEY` for `gpt-live-1`, or `GEMINI_API_KEY` for Gemini.
  Credentials stay in the local controller, never in browser assets.
- A configured Lectic backend and its credentials. Its provider can differ
  from the voice provider.

The full Lectic distribution includes the plugin. For manual installation,
copy this directory beneath `LECTIC_RUNTIME`, `LECTIC_CONFIG`, or
`LECTIC_DATA`, preserving the executable bit on `lectic-live.ts`. No npm
installation is needed. To discover plugins from a checkout:

```sh
export LECTIC_RUNTIME="$PWD/extra/plugins"
lectic live --help
```

## Start and stop

Use a trusted Lectic conversation as the backend seed:

```sh
lectic live -f ./my-assistant.lec
```

`--model gpt-live-1` selects the current default explicitly. Unsupported
models fail before startup. For Gemini:

```sh
lectic live -f ./my-assistant.lec --model gemini-3.8-live --voice Kore
```

Gemini uses its production transport and the same configured Lectic backend,
not the isolated spike. It exposes only `delegate`. Gemini `--resume` still
fails before credential lookup or startup. See the
[delegation acceptance checklist](GEMINI_DELEGATION.md) before testing.

The seed is never modified. Its location determines configuration discovery;
launch from the directory where you want backend tools to work. Live uses
normal Lectic configuration, including inherited tools, hooks, and sandbox
settings. **It is not read-only and adds no separate approval system.**

The [example backend](examples/voice-backend.lec) configures a shell with
write and network access. Review it and your inherited configuration first:

```sh
lectic live \
  -f ./extra/plugins/lectic-live/examples/voice-backend.lec \
  --no-open --max-session-seconds 180
```

Opening the private URL requests microphone permission, then automatically
starts a paid session. Do not share the URL; its secret is removed from the
address bar and is not saved in browser storage.

The page shows only a black-on-white spectrum of the agent's audio. There
are no buttons or captions. Status, transcripts, errors, and usage appear
in the browser console. If playback is blocked, click anywhere or press a
key to retry audio without creating another session. Billing continues
while playback is blocked; close the tab if audio cannot be enabled.

Close the tab to stop capture/playback, cancel local backend work, and
request session shutdown. Reloading or navigating away also ends the
session. Ctrl-C stops the local controller; otherwise it stays running.
Relaunch after explicit ending, reloading, or an unrecoverable failure.
Gemini can wait for microphone wake after an established session disconnects;
see its recovery rules below.

### Idle and wake

By default, the ring begins fading after 15 seconds without activity. At
30 seconds, Live closes the paid session and leaves a gray ring. Speech,
agent audio, microphone-level changes, and pending backend work prevent
idle shutdown. `--idle-timeout N` changes the timeout; dimming starts halfway
through it.

The microphone stays active **locally** while idle to detect changes from
ambient sound. Make a short sound, then wait for the ring to turn black
before speaking your request. Wake audio is not buffered, so speech during
reconnection can be missed. Steady noise does not count as activity;
browser audio processing can affect sensitivity. Clicking or pressing a key
can resume suspended audio analysis but does not itself wake the session.

Wake creates a fresh session only after the old transport closes. OpenAI
also requires final provider usage; Gemini cannot confirm remote finality
or final usage and says so explicitly. Bounded text history preserves
conversation context, not old audio or model state.
Pending jobs are never restarted. A failed or unconfirmed shutdown/start
is not automatically retried.

## Launch and shutdown

The CLI prints only the private URL to stdout; diagnostics and local history
paths go to stderr. It never opens a browser automatically. For example:

```sh
chromium --app "$(lectic live -f ./voice-backend.lec)"
```

When stdout is a terminal, the controller stays in the foreground and Ctrl-C
stops it. With redirected stdout (including command substitution), a detached
controller starts and the launcher exits after printing its URL. Its PID is
reported on stderr; `kill PID` requests graceful shutdown if needed. Opening
the URL starts a paid session after microphone permission. Keep the URL
private.
A controller whose URL is never opened stays ready until explicitly stopped.

Closing the tab cancels local backend work, closes the provider transport,
and exits the controller. Missing browser heartbeats trigger the same cleanup
after about ten seconds, including while sleeping or before paid startup.
The End button leaves a short window for final diagnostics; the controller
then exits when the tab closes or its heartbeat expires. Local cleanup does
not establish rollback of actions or final provider billing.

Public backend results may contain up to 16 KiB of UTF-8 text. Keep them
concise and free of private reasoning or tool dumps. Gemini receives a single
function response. OpenAI receives numbered, acknowledged parts when needed
to respect its per-append token limit. Interrupted delivery is not retried.
Backend failures produce a safe failure result for the voice model, not a
process crash or a raw stack trace. The next request can still run; uncertain
actions must be checked before retrying. With `--keep-history`, backend run
diagnostics are retained locally.

## Options

All duration values are integer seconds from 1 to 3600.

- `-f PATH`: required, trusted backend seed.
- `--no-open`: accepted for compatibility; the browser never auto-opens.
- `--port N`: loopback port, 0–65535; default 0 chooses an available port.
- `--model NAME`: `gpt-live-1` (default) or `gemini-3.8-live`.
- `--voice NAME`: provider-specific spelling, preserved exactly. OpenAI uses
  lowercase names and defaults to the API's choice. Gemini defaults to `Kore`;
  use catalog spelling such as `Kore` or `Aoede`. Syntax is checked locally;
  the provider may reject unknown names.
- `--max-session-seconds N`: cumulative voice budget; default 600.
  Includes startup, shutdown, and per-session minimums, not disconnected
  idle time. Wake does not reset it. Gemini instead caps elapsed time from
  connection startup through shutdown, without OpenAI's minimum or dollars.
  It is not a strict spending cap.
- `--idle-timeout N`: idle disconnect timeout; default 30. Both providers
  retain local microphone analysis for fresh-session wake.
- `--backend-timeout N`: timeout per backend subprocess phase; default 120.
  This is not a whole-task latency limit.
- `--context-seconds N`: recent speech/finding window; default 300.
  Size limits also apply. This does not expire disk archives.
- `--keep-history`: save local transcripts, task context, and backend files.
- `--resume ID`: restore saved context; implies `--keep-history` and still
  requires `-f`. Not yet available with Gemini.

### Cost

For OpenAI, voice is estimated at $0.05/minute, billed per second, with a
15-second minimum per session creation attempt. Each wake has its own
minimum and requires room in the remaining budget. Backend costs are
separate and unmeasured. These estimates are not an invoice; check current
[OpenAI pricing](https://developers.openai.com/api/docs/models/gpt-live-1).
Explicit request rejections remove that attempt's speculative minimum
from the estimate without changing prior sessions' usage. A lost creation
response or other uncertain startup failure may still incur a charge.
Neither is automatically retried.

Gemini reports elapsed connection time and the latest documented token
counters, not a summed total or dollar estimate. Closing the socket does
not make those counters final. Provider limits (`GoAway`) and transport loss
stop the session; relaunch explicitly. No rotation or automatic retry.

## History and privacy

History stays in memory by default, including across idle wakes. Temporary
backend files are removed on normal completion, failure, or cancellation;
a crash can leave them behind. Live does not record raw audio. OpenAI uses
`store: false`; Gemini has no corresponding setting in this setup. Google's
paid/unpaid service terms and abuse-monitoring retention apply separately;
do not assume zero provider retention. See [Gemini contract and policy
links](GEMINI_CONTRACT.md#terminal-events-accounting-and-retention).
Configured hooks and Lectic's script cache are independent of these settings.

To save context for another launch:

```sh
lectic live -f ./my-assistant.lec --keep-history
# Use the archive ID printed in the terminal:
lectic live -f ./my-assistant.lec --resume SAVED-ID
```

Archives are stored at `$LECTIC_STATE/live/ID`. The default state base is
`$XDG_STATE_HOME/lectic`, or `~/.local/state/lectic`. Each launch gets a new
archive; resuming leaves the original unchanged.

An archive contains session metadata, observed transcripts and lifecycle
events, a bounded `context.json` checkpoint, and backend request/output
files under `runs/`. Full backend records can include tool calls, thought
blocks, configuration, and credentials; failure diagnostics are saved when
available. Directories use mode 0700 and files 0600, but content is **neither
encrypted nor redacted**. Transport authorization headers and SDP are not
archived. Review archives and console/terminal logs before sharing.

Resume and idle wake restore up to 8 KiB of checkpoint context. GPT-Live
receives bounded user/assistant text history; Lectic receives prior speech,
findings, and task outcomes on the next new delegation. Neither receives
the full archive. Older context may be omitted, and stale facts need
checking. Resume does not restore credentials, permissions, or configuration:
choose the seed and working directory on each launch.

Archives do not auto-expire. Stop the controller and delete the printed
archive directory to remove retained history. Disk use grows with the
conversation and backend output. Checkpoints can lose the latest update
on a crash; they are context, not a transactional action log.

## Permissions and limitations

Live targets a trusted, single-user machine, not remote or multi-user
hosting. The controller binds to loopback and authenticates local controls
to protect against unrelated browser pages, not a compromised local account.

Tools, hooks, executable configuration sources, and approvals belong to
Lectic configuration. `LECTIC_LIVE_WORKSPACE` names the invocation directory
for user-configured sandbox profiles. Live itself does not require one.

Live always passes `--no-macros`: user-message directives and macros remain
literal in both seed history and appended input. Select the interlocutor
in configuration, not through a seed directive. Generated context is also
encoded as inert data. This prevents parser-level execution, not model-level
prompt injection; tools, hooks, and ordinary Markdown attachment loading
remain enabled.

Backend runs are serialized, with at most four queued delegations and a
60-second queue expiry. Results are short public summaries, not raw tool
output. A newer delegation withholds an older run's result, not its actions.
OpenAI also conservatively withholds on new user speech, even a backchannel
such as “mm-hmm”. Gemini uses explicit task arguments: delayed transcripts
and backchannels alone do not invalidate results. Its voice prompt asks for
a new delegation on correction; provider cancellation stops only matching
calls. Speech alone is not proof of cancellation. The next delegation gets
recent findings for reconciliation; already-sent results cannot be recalled.
Gemini sends results/statuses using non-interrupting `WHEN_IDLE` scheduling,
without claiming provider acknowledgment or delivery to the user's ears.

**Cancellation, failure, or a missing answer does not undo actions.** Local
process cleanup cannot guarantee remote cancellation. Live never
intentionally replays old jobs or blindly resends results, but a model can
still choose to repeat a tool call. Check actual state before retrying
uncertain work. An acknowledged result is not proof it was spoken or heard.

## Troubleshooting

- **No microphone or audio:** inspect browser permissions and the console.
  Click or press a key to retry blocked playback or suspended audio analysis.
- **Backend failure:** inspect the terminal and, if enabled, the archive's
  run diagnostics. Raw errors are not spoken. An unknown `--no-macros`
  option means the backend Lectic on PATH needs updating.
- **Wrong plugin version:** avoid duplicate installations. A Nix wrapper
  can prioritize bundled plugins over `LECTIC_RUNTIME`. Select a copy with
  `lectic script /absolute/path/to/lectic-live/lectic-live.ts --help`;
  the backend executable on PATH must also be current.
- **Connection or shutdown failure:** do not blindly retry. Browser loss
  triggers a 10-second heartbeat watchdog; shutdown confirmation is distinct
  from local audio cleanup. Unconfirmed finalization does not prove billing
  stopped. Transport loss does not automatically reconnect or replay work.

See [CONTRACT.md](CONTRACT.md) for protocol details and implementation limits.
The visualization is adapted from
[Roy-05/audio-visualizer](https://github.com/Roy-05/audio-visualizer)
(MIT, Saket Roy).

## Gemini preview and isolated spike

Stage 3 adds authenticated binary PCM relay, native-rate microphone capture,
bounded WebAudio playback, and interruption flushing to `lectic live`.
A suspended AudioContext pauses capture and drops output rather than queuing
old speech. Click or press a key to resume the same session. No provider
connection is opened until microphone permission and initial audio unlock.
If the audio element itself remains blocked, time can still be billable.

Gemini also parks after established-session provider loss or browser playback
failure, once transport closure is confirmed. Speak to wake a fresh session
with bounded text context; no audio, old response, or work is replayed.
Explicit stop, startup failure, heartbeat loss, time limits, uncertain close,
and ambiguous/invalid local protocol failures remain terminal. CLI `--resume`
is still unsupported. The cumulative connection-time cap survives wakes.

The console now distinguishes browser playback/capture overload, protocol
validation errors, provider close codes, and known turn rejection reasons.
Unknown close text is classified, not reflected; no raw provider errors or
credential URLs are logged. `playback_overload` includes queued seconds and
source count. Playback now allows five minutes of queued/scheduled audio,
with at most 400 ms scheduled ahead and 32 source nodes. Unscheduled PCM16
is packed into 100 ms blocks allocated as needed (about 14.4 MB at the
limit, plus browser/object overhead). Interruption, pause and close discard
both layers. A turn rejection by itself does not force disconnection.

The user reported successful stage 1 duplex audio and delegation using the
separate spike, and later confirmed the production playback scheduling fix.
That is not blanket acceptance of all production behavior. Follow the
[audio checks](GEMINI_TRANSPORT.md) and
[delegation checks](GEMINI_DELEGATION.md). [PROVIDERS.md](PROVIDERS.md)
describes the current boundary. [GEMINI_SPIKE.md](GEMINI_SPIKE.md) remains an
isolated, opt-in harness, not normal startup or production acceptance.
