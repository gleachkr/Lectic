# Lectic Live

A local speech interface to Lectic, using OpenAI or Gemini for conversation
and your configured Lectic backend for tools, actions, or deeper reasoning.
Greetings and ordinary conversation do not independently run Lectic. Both
voice providers support delegation, microphone wake, and saved-context
resume; you can keep speaking while backend work runs.

The implementation is offline-tested. Browser validation was reported by
its user; provider billing and retention remain subject to their terms.

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

## Choosing a voice provider

`--model` selects only the voice provider, not your backend model or tools.
The default remains `gpt-live-1`; an archive never changes this selection.

| Behavior | OpenAI | Gemini |
| --- | --- | --- |
| Model | `gpt-live-1` | `gemini-3.8-live` |
| Voice credential | `OPENAI_API_KEY` | `GEMINI_API_KEY` |
| Browser audio | WebRTC | Native-rate PCM via local WebSocket |
| Result receipt | Correlated append acknowledgment | Send only |
| Usage | Seconds and estimated dollars | Latest partial tokens and time |
| Unexpected provider loss | Terminal | Local mic wake after safe cleanup |
| Provider storage option | `store: false` | No equivalent configured |

Voice names are case-sensitive. OpenAI accepts lowercase syntax (for example
`marin`) and leaves the default to the API. Gemini defaults to `Kore`; other
catalog examples include `Aoede`. Live validates syntax, not catalog
membership: an unknown or unavailable voice is rejected by the provider.
Consult the current [OpenAI session reference][openai-create] or the
[Gemini voice catalog][gemini-voices] before changing voices. Gemini names
must start uppercase; names are never silently lowercased or substituted.

[openai-create]:
  https://developers.openai.com/api/reference/resources/live/methods/create
[gemini-voices]: https://ai.google.dev/gemini-api/docs/speech-generation

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

Gemini uses the same configured Lectic backend and exposes only `delegate`.
Both providers support `--resume ID` as fresh text context, not
provider-native resumption. See the [adapter contract](CONTRACT.md) for
transport, delegation and lifecycle behavior.

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
session and controller. Ctrl-C also requests local controller shutdown.
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

Closing the tab or whole browser cancels local backend work, closes the
provider transport, and exits the controller after cleanup. An authenticated
page-lifetime WebSocket detects browser exit even if the browser drops its
final HTTP request. It remains open across idle/wake for both providers.
Missing browser heartbeats trigger the same cleanup after about ten seconds,
including while sleeping or before paid startup.
Terminal failures leave the page open for console diagnostics; the controller
exits when the tab closes or its heartbeat expires. There is no End button.
Local cleanup does not establish rollback of actions or final provider
billing. `--keep-history` affects persistence, not controller lifetime.

The backend's final `lectic-live-completed`, `lectic-live-clarification`, or
`lectic-live-failed` code fence contains a plain-text public result; the
backend model no longer has to escape its summary as JSON. Public backend
results may contain up to 16 KiB of UTF-8 text. Keep them concise and free
of private reasoning or tool dumps. Gemini receives a single
function response. OpenAI receives numbered, acknowledged parts when needed
to respect its per-append token limit. Interrupted delivery is not retried.
Backend failures produce a safe failure result for the voice model, not a
process crash or a raw stack trace. The next request can still run; uncertain
actions must be checked before retrying. With `--keep-history`, backend run
diagnostics are retained locally.

## YAML voice configuration

The top-level `live` mapping in the seed's `.lec` header (or inherited Lectic
configuration) sets defaults for the voice interface. It does not change
`interlocutor.model` or `interlocutor.prompt`, which configure backend runs.
Explicit `--model` and `--voice` flags override the corresponding YAML keys.

```yaml
---
interlocutor:
  name: Assistant
  prompt: Help with tasks.
live:
  model: gemini-3.8-live
  voice: Kore
  prompt: Speak concisely and ask before long investigations.
---
```

`live.prompt` supplements the provider-specific voice instructions; it
cannot replace the delegation and safety protocol. It accepts inline text,
`file:` (including `file:local:./path`), or `exec:` using ordinary Lectic
prompt-source syntax. A single-line `exec:` runs directly, not through a
shell. A multiline script needs a shebang. Sources execute in the invocation
directory, not the seed's directory. They run **before each new paid voice
session**, including idle wake; they do not run for backend tasks.

```yaml
live:
  prompt: |
    exec:#!/usr/bin/env bash
    printf 'Current time: %s\n' "$(date -Is)"
    cat "$LECTIC_DATA/live-memory.txt"
```

The resolved prompt is sent to the voice provider. Review scripts and output
for secrets. Live bounds prompt output to 16 KiB and commands to five seconds;
a failed or oversized source stops startup before provider creation, without
an automatic retry. A source is not run when the controller URL is printed;
it runs when the browser starts (or wakes) a session. The controller uses the
current seed and configuration on each launch, not saved archive metadata.

## Options

All duration values are integer seconds from 1 to 3600.

- `-f PATH`: required, trusted backend seed.
- `--no-open`: accepted for compatibility; the browser never auto-opens.
- `--port N`: loopback port, 0–65535; default 0 chooses an available port.
- `--model NAME`: `gpt-live-1` (default) or `gemini-3.8-live`; overrides
  `live.model`.
- `--voice NAME`: overrides `live.voice`; provider-specific spelling,
  preserved exactly. OpenAI uses
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
  requires `-f`. Works with either voice provider, including across providers.

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
stop the connection immediately. Confirmed closure permits parking for local
microphone wake; uncertain closure requires a relaunch. Neither automatically
creates another session. No rotation or automatic retry.

## History and privacy

History stays in memory by default, including across idle wakes. Temporary
backend files are removed on normal completion, failure, or cancellation;
a crash can leave them behind. Live does not record raw audio. OpenAI uses
`store: false`; Gemini has no corresponding setting in this setup. Google's
paid/unpaid service terms and abuse-monitoring retention apply separately;
do not assume zero provider retention. Check Google's current
[Gemini API documentation](https://ai.google.dev/gemini-api/docs/live)
and applicable terms before use.
Configured hooks and Lectic's script cache are independent of these settings.

To save context for another launch:

```sh
lectic live -f ./my-assistant.lec --keep-history
# Use the archive ID printed in the terminal:
lectic live -f ./my-assistant.lec --resume SAVED-ID
# Choose Gemini explicitly; the archive does not select the voice model:
lectic live -f ./my-assistant.lec --model gemini-3.8-live --resume SAVED-ID
```

Archives are stored at `$LECTIC_STATE/live/ID`. The default state base is
`$XDG_STATE_HOME/lectic`, or `~/.local/state/lectic`. Each launch gets a new
archive; resuming leaves the original unchanged. Provider/model metadata is
saved for diagnosis only. An old or other-provider archive can supply context,
but never credentials, a session handle, or an executable queue. A new launch
has a new time budget; only idle wakes within that launch share its budget.

An archive contains session metadata, observed transcripts and lifecycle
events, a bounded `context.json` checkpoint, and backend request/output
files under `runs/`. Full backend records can include tool calls, thought
blocks, configuration, and credentials; failure diagnostics are saved when
available. Directories use mode 0700 and files 0600, but content is **neither
encrypted nor redacted**. Transport authorization headers and SDP are not
archived. Review archives and console/terminal logs before sharing.

Resume and idle wake restore up to 8 KiB of checkpoint context. GPT-Live
receives bounded user/assistant text history. Gemini receives user/model text
plus inert task outcomes, including uncertain actions/delivery, in its special
initial-history handshake before microphone input. Both wait for new speech;
they must not greet, answer an old request, or restart saved work. Lectic
receives prior speech, findings, and task outcomes on the next new delegation.
Neither receives the full archive. Older context may be omitted, and stale
facts need checking. Resume does not restore credentials, permissions, or
configuration: choose the seed and working directory on each launch.

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
- **Backend failure:** the terminal identifies the task number and a safe
  reason (for example, process exit code, timeout, or output size limit).
  The voice model receives that reason but not raw stderr. For the actual
  backend diagnostic, launch with `--keep-history` and inspect `error.txt`
  under the printed archive's `runs/` directory. It may contain secrets;
  review it before sharing. Unknown exceptions report only an unexpected
  failure. An unknown `--no-macros`
  option means the backend Lectic on PATH needs updating. Cancellation does
  not undo completed actions; inspect actual state before retrying.
- **Wrong plugin version:** avoid duplicate installations. A Nix wrapper
  can prioritize bundled plugins over `LECTIC_RUNTIME`. Select a copy with
  `lectic script /absolute/path/to/lectic-live/lectic-live.ts --help`;
  the backend executable on PATH must also be current.
- **Connection or shutdown failure:** do not blindly retry. Browser loss
  triggers a 10-second heartbeat watchdog; shutdown confirmation is distinct
  from local audio cleanup. Unconfirmed finalization does not prove billing
  stopped. Transport loss does not automatically reconnect or replay work.
- **Gemini setup rejected:** check `GEMINI_API_KEY`, model access, and exact
  voice spelling. The controller uses v1alpha and never retries another
  endpoint or model automatically. Credentials for the backend are separate.
- **Gemini silent or delayed:** inspect the console for suspended WebAudio,
  worklet errors, or `playback_overload`. Capture uses the actual native
  AudioContext rate; no client resampler is installed. Interruption drops
  both queued and scheduled output; lost audio is never replayed.
- **Gemini gray ring after loss or provider limit:** if closure was confirmed,
  a short sound requests a fresh text-seeded connection. Wait for the black
  ring before speaking. Startup/time-budget failures and uncertain closure
  require an explicit relaunch, not repeated wake attempts.
- **OpenAI cannot wake:** replacement needs final session usage and room for
  another 15-second minimum. Unconfirmed finalization is not safe to retry.
- **Controller takes ten seconds to exit:** older copies relied on a final
  HTTP request that can be dropped on whole-browser exit. Update the plugin;
  the page-lifetime socket now triggers cleanup without that request. History
  retention is unrelated. Check for duplicate installations if the delay
  persists. The watchdog and Ctrl-C remain fallbacks; cleanup is not skipped
  to force a faster exit. Report the browser, launch command and plugin path,
  not the private URL, raw history or provider credentials.

See [CONTRACT.md](CONTRACT.md) for protocol details and implementation limits.
The visualization is adapted from
[Roy-05/audio-visualizer](https://github.com/Roy-05/audio-visualizer)
(MIT, Saket Roy).

## Gemini audio and recovery

Gemini uses authenticated binary PCM relay, native-rate microphone capture,
bounded WebAudio playback, and interruption flushing.
A suspended AudioContext pauses capture and drops output rather than queuing
old speech. Click or press a key to resume the same session. No provider
connection is opened until microphone permission and initial audio unlock.
If the audio element itself remains blocked, time can still be billable.

Gemini also parks after established-session provider loss or browser playback
failure, once transport closure is confirmed. Speak to wake a fresh session
with bounded text context; no audio, old response, or work is replayed.
Explicit stop, startup failure, heartbeat loss, time limits, uncertain close,
and ambiguous/invalid local protocol failures remain terminal. CLI `--resume`
restores saved text context on a new launch; it does not revive the
connection. The cumulative connection-time cap survives wakes within one
launch.

The console distinguishes browser playback/capture overload, protocol
validation errors, provider close codes, and known turn rejection reasons.
Unknown close text is classified, not reflected; no raw provider errors or
credential URLs are logged. `playback_overload` includes queued seconds and
source count. Playback allows five minutes of queued/scheduled audio,
with at most 400 ms scheduled ahead and 32 source nodes. Unscheduled PCM16
is packed into 100 ms blocks allocated as needed (about 14.4 MB at the
limit, plus browser/object overhead). Interruption, pause and close discard
both layers. A turn rejection by itself does not force disconnection.
