# Lectic Live

A local speech interface to Lectic. GPT-Live handles the conversation and
asks your configured Lectic backend for tools, actions, or deeper reasoning.
Greetings and ordinary conversation do not independently run Lectic. You
can keep speaking while backend work runs.

## Setup

You need:

- A POSIX host and Lectic on PATH with `--no-macros` support.
- A browser with WebRTC, microphone permission, and audio output.
- `OPENAI_API_KEY` set locally, with access to `gpt-live-1`.
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
Relaunch the command after ending, reloading, or a connection failure.

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

Wake creates a fresh session only after confirmed shutdown. Bounded text
history preserves conversation context, not old audio or model state.
Pending jobs are never restarted. A failed or unconfirmed shutdown/start
is not automatically retried.

## Options

All duration values are integer seconds from 1 to 3600.

- `-f PATH`: required, trusted backend seed.
- `--no-open`: print the URL without opening the browser via `xdg-open`.
- `--port N`: loopback port, 0–65535; default 0 chooses an available port.
- `--voice NAME`: voice at session creation; default is the API's choice.
- `--max-session-seconds N`: cumulative voice budget; default 600.
  Includes startup, shutdown, and per-session minimums, not disconnected
  idle time. Wake does not reset it.
- `--idle-timeout N`: idle disconnect timeout; default 30.
- `--backend-timeout N`: timeout per backend subprocess phase; default 120.
  This is not a whole-task latency limit.
- `--context-seconds N`: recent speech/finding window; default 300.
  Size limits also apply. This does not expire disk archives.
- `--keep-history`: save local transcripts, task context, and backend files.
- `--resume ID`: restore saved context; implies `--keep-history` and still
  requires `-f`.

### Cost

The plugin estimates voice cost at $0.05/minute, billed per second, with a
15-second minimum per session creation attempt. Each wake has its own
minimum and requires room in the remaining budget. Backend costs are
separate and unmeasured. These estimates are not an invoice; check current
[OpenAI pricing](https://developers.openai.com/api/docs/models/gpt-live-1).
Explicit request rejections remove that attempt's speculative minimum
from the estimate without changing prior sessions' usage. A lost creation
response or other uncertain startup failure may still incur a charge.
Neither is automatically retried.

## History and privacy

History stays in memory by default, including across idle wakes. Temporary
backend files are removed on normal completion, failure, or cancellation;
a crash can leave them behind. Live does not record raw audio and uses
`store: false`. Provider retention, configured hooks, and Lectic's script
cache remain independent of these settings.

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
output. New user speech or a newer delegation during a run conservatively
withholds its result, even for a backchannel such as “mm-hmm”. Speech alone
does not cancel the work. The next delegation receives recent findings for
reconciliation; already-sent commentary cannot be recalled.

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
