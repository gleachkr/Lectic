# Lectic Live: read-only voice delegation

Slices 1–3 of `PLAN.md` are implemented. GPT-Live owns the spoken
conversation; Lectic runs only when GPT-Live delegates backend work.
Greetings, caption fragments, and pauses do not independently run Lectic.
The browser stays connected while a serialized backend lookup runs.

The user has reported successful browser use, including backend
delegation. Automated tests use fake Live transports and a deterministic
provider with the real Lectic CLI and sandboxed tools. They make no paid
calls. This is a read-only vertical slice, not an approval-gated coding
assistant. Opt-in local history can resume backend task context in a new
voice session; it does not reconnect to an old Live session.

## Trust model

This plugin runs on a friendly, single-user machine. The owner, local
configuration, and chosen executables are trusted. Keeping your own history
is an ordinary opt-in feature, not an unsupported security exception.

Loopback authentication protects local controls from unrelated web pages.
Inert context encoding prevents speech from becoming Lectic source syntax.
The read-only sandbox limits model/tool mistakes; a trusted user does not
make model-generated commands infallible. This is not remote multi-user
hosting or protection against a compromised local account.

## Requirements and installation

- Linux with working Bubblewrap (`bwrap`) and user namespaces.
- A browser with WebRTC, microphone permission, and working audio output.
- A local `OPENAI_API_KEY` with access to `gpt-live-1`.
- A configured Lectic backend provider and its credentials. It can differ
  from the voice provider; the example uses OpenAI and `gpt-5.4`.
- Lectic on PATH, built from a revision with `parse --effective-header`.
  The plugin fails closed on an older CLI rather than skipping inspection.

The full Lectic distribution includes `extra/plugins`. For a manual
installation, copy this entire directory beneath `LECTIC_RUNTIME`,
`LECTIC_CONFIG`, or `LECTIC_DATA`, preserving the executable bit on
`lectic-live.ts`. Avoid duplicate copies in a discovery root.

To discover it directly from this checkout:

```sh
export LECTIC_RUNTIME="$PWD/extra/plugins"
lectic live --help
```

The plugin uses Lectic's bundled Bun runtime, not an npm installation.
Its browser assets are embedded TypeScript imports, so installation and
script bundling do not depend on source-tree asset paths. Backend children
resolve the public `lectic` executable on PATH, not `process.execPath`.

## Start a session

From the repository you want Lectic to inspect, use the example seed:

```sh
lectic live \
  -f ./extra/plugins/lectic-live/examples/voice-backend.lec \
  --no-open --max-session-seconds 180
```

For another repository, copy the example there or pass its absolute path.
The invocation working directory is the read-only tool workspace.
The seed path, not the temporary backend record, determines Lectic's
configuration discovery. Set credentials in your local environment; never
put them in a browser URL or share the private launch URL.

Opening the printed URL starts the conversation automatically. Microphone
permission is requested before the billable API call. Captured tracks remain
disabled until the sideband is attached and the browser has received
`session.started`. The URL secret is removed from the address bar immediately
and is not saved in browser storage.

The page displays only a centered, black-on-white radial spectrum of the
agent's incoming audio, adapted from
[Roy-05/audio-visualizer](https://github.com/Roy-05/audio-visualizer)
(MIT, Saket Roy). The microphone never feeds the visualization. There are no
buttons, captions, status panels, or other visible controls. Status changes,
transcript fragments, lifecycle diagnostics, errors, and final usage go to
`console.log`. Console transcripts may contain sensitive conversation text;
review them before sharing.

If the browser blocks autoplay or suspends Web Audio, click anywhere on the
page or press a key to retry audio. This never creates another session.
Browser permission prompts cannot be bypassed. A blocked playback attempt
does not pause billing: close the tab if audio cannot be enabled.

Close the tab or browser to stop microphone capture and playback immediately,
cancel local backend work, and request Live shutdown. Reloading or navigating
away also ends the session. If the browser crashes or drops the close request,
the controller's 10-second heartbeat watchdog attempts shutdown. Merely
switching tabs is not an explicit end request. Ctrl-C shuts down the local
controller as well; the controller otherwise stays open after the session.

Each command launch allows one session-creation attempt. After closing,
startup failure, or reload, relaunch the command for a fresh session.
There is no silent retry, reconnection, or recovery of pending work.
Use `--resume ID` on a later launch to reuse saved backend context.

### Flags

- `-f PATH`: required, trusted backend seed; never modified by the adapter.
- `--no-open`: print the URL without invoking `xdg-open`.
- `--port N`: loopback port; default 0 selects an available port.
- `--voice NAME`: choose the voice at creation; omission uses API default.
- `--max-session-seconds N`: duration budget, default 600, maximum 3600.
- `--backend-timeout N`: timeout per backend subprocess phase in seconds,
  default 120, maximum 3600. This is not a whole-task latency guarantee.
- `--context-seconds N`: recent speech/finding working window, default 300
  seconds, minimum 1, maximum 3600. Size limits apply independently. This
  does not limit the opt-in disk archive's lifetime.
- `--keep-history`: save transcripts, task context, and backend run files.
- `--resume ID`: load saved backend context into a fresh session; implies
  `--keep-history`. Still requires `-f`; opening the URL starts the session.
- `--spike-info`: offline executable and embedded-prompt check.

### Save and resume context

```sh
lectic live -f ./voice-backend.lec --keep-history
# The terminal prints the archive directory and its ID.
lectic live -f ./voice-backend.lec --resume SAVED-ID
```

Archives live at `$LECTIC_STATE/live/ID`. If `LECTIC_STATE` is unset, the
base is `$XDG_STATE_HOME/lectic`, or `~/.local/state/lectic` when that is
also unset. Each launch creates a new archive ID; resuming leaves the old
archive unchanged and keeps the application conversation ID.

A saved archive contains:

- `session.json`: creation time, seed/workspace paths, and resume parent.
- `events.jsonl`: observed transcript and lifecycle events, plus working
  context checkpoints. This is an archive, not just the recent UI window.
- `context.json`: latest atomic, bounded checkpoint for the next resume.
- `runs/lectic-live-*/request.json`: each backend context envelope.
- `runs/lectic-live-*/run.lec`: full successfully captured backend output,
  including tool records and any thought blocks, not just public findings.
- `runs/lectic-live-*/error.txt`: backend failure details when available.
  A failed or cancelled child may have no completed `run.lec`.

Directories are 0700 and files 0600. Content is **not encrypted or
redacted**. Transcripts, repository content, tool arguments/results, seed
configuration, and diagnostics may contain sensitive information. Keep
these files as you would other personal Lectic conversations; inspect them
before sharing. No raw audio, API authorization headers, or SDP is recorded
by the archive, but backend records can themselves contain credentials.
Provider retention is independent of this local option; Live creation
continues to use `store: false`.

`--resume` supplies up to 8 KiB of saved speech, findings, and historical
task/delivery states to Lectic on the next **new delegation**. GPT-Live does
not receive the old audio or entire transcript: it delegates questions
about earlier sessions to the backend. Old tasks are historical records,
not a restored execution queue. Pending jobs are not restarted, old answers
are not resent, and prior delivery does not establish playback or success.
The backend is prompted to reuse applicable findings and check stale facts.

Choose the seed and working directory explicitly on each launch. Resume
does not restore commands, credentials, configuration, or tool permissions
from the archive. Earlier context is encoded as inert input, not replayed
as `.lec` source. Opening the private URL starts a new billable session
after microphone permission; there is no separate Start confirmation.

Working context remains bounded; full archives are not automatically
loaded into model context. The saved checkpoint keeps recent context
independently of working-window age expiry. Its 8 KiB size limit can omit
older entries; omissions are marked. The local `/clear` API resets the next
checkpoint but does not erase archived records; it has no browser control.
To delete retained history, stop the controller and remove its printed
archive directory yourself. Archives do not auto-expire. Disk use grows
with conversation length and backend output.

Checkpoints are atomic replacements, not a transactional operation log.
A crash can lose the latest update; a disk-write error is reported locally.
Do not treat retained status as proof that interrupted work completed.
Without either flag, history remains in memory and temporary backend files
are removed on normal completion, failure, or cancellation.

### Checkout-backed QA launcher

If your installed Lectic lacks the new parse flag, use a development
launcher instead of mixing an old backend CLI with the new plugin.
From this checkout, with Bun and dependencies available:

```sh
export LECTIC_CHECKOUT="$PWD"
qa=$(mktemp -d)
mkdir -p "$qa/bin" "$qa/config" "$qa/data"
cat > "$qa/bin/lectic" <<'SH'
#!/bin/sh
exec bun "$LECTIC_CHECKOUT/src/main.ts" "$@"
SH
chmod +x "$qa/bin/lectic"
export PATH="$qa/bin:$PATH"
export LECTIC_RUNTIME="$LECTIC_CHECKOUT/extra/plugins"
cp extra/plugins/lectic-live/examples/voice-backend.lec "$qa/backend.lec"
LECTIC_CONFIG="$qa/config" LECTIC_DATA="$qa/data" \
  lectic live -f "$qa/backend.lec" --no-open --max-session-seconds 180
```

This uses an isolated configuration seed outside the repository while
keeping the repository as the tool working directory. It does not change
your normal config. Environment credentials still apply. Remove `$qa`
when finished; use a fresh shell to restore your normal PATH.

A direct native compile was attempted in the development tool environment:
Bun 1.3.0 reported success but produced a zero-header, non-executable file.
The checkout launcher and plugin bundling through the installed Lectic
runtime were tested instead. This is not a claim that normal release
builds fail.

Nix's installed wrapper can prepend its bundled plugin directory ahead of
`LECTIC_RUNTIME`. In that case, an installed `lectic live` may run an older
bundled plugin despite your environment override. Use the checkout launcher
above, or select the plugin explicitly for installed-runtime testing:

```sh
lectic script /absolute/path/to/lectic-live/lectic-live.ts --spike-info
```

For a real session, the backend `lectic` on PATH must also support the new
parse option. Explicit script selection alone does not update that backend.

## Read-only policy

Use the exact sandbox stanza from the example. The normal writable
repository sandbox is not a substitute. Lectic's existing `sandbox`
mechanism wraps exec tools; the plugin does not implement a second tool
runner or an approval system.

The Bubblewrap profile exposes system executables and the invocation
workspace read-only, supplies private temporary directories and process
namespaces, disables tool networking, and clears the tool environment.
Host home directories outside the workspace and host `/run` are absent.
The backend model process stays outside the tool sandbox so it can use
its provider credentials and network connection.

Before launch and each lookup, the plugin inspects the effective merged
configuration using the public parse CLI. It accepts one interlocutor
with an explicit non-Codex provider and sandboxed, single-line exec tools.
It rejects hooks, macros, kits, subagents, MCP, provider-native tools,
executable prompt/account/usage sources, tool sandbox overrides, and tool
or interlocutor environment overrides. Even empty unsupported fields
are rejected. It does not silently remove inherited permissions.

A profile rejection usually means a system or workspace configuration
contributed an unsupported field. Use a deliberately isolated seed and
configuration, as above, rather than weakening the policy. Keep the exact
sandbox stanza when changing the model or tool descriptions.

Configuration, the seed body, executable search paths, and system binaries
are trusted local inputs. Do not edit configuration concurrently with a
session. The seed can contain trusted prior context; it is not a place to
paste untrusted voice text or executable directives. Only the adapter's
serialized voice context is tested as parser-inert.

Read-only is not confidentiality: files inside the exposed repository can
be read and sent to the backend provider. Use a workspace without secrets,
and do not launch from `/` or your home directory. The workspace is audited
for existing pathname UNIX sockets, which can bypass network namespaces;
those workspaces are rejected. Do not create or move IPC sockets into the
workspace during a session. The audit is bounded at 200,000 entries and
10 seconds and does not provide a concurrent-filesystem security lock.

## Configuration, context, and results

Generation uses the original seed via `lectic -f SEED --format full`,
with the adapter prompt and inert context envelope on stdin. Stdin is
explicitly closed. Unlike `lectic -if`, this does not append to the seed.
The original working directory and seed base are preserved for imports,
relative paths, and `LECTIC_FILE`; no flattening is used for generation.

Full output is stored separately as `run.lec`, temporarily by default or
in the selected history archive with `--keep-history`. The completed
record is parsed on stdin from the seed directory, never with `-f` aimed
at a managed state file. `parse --effective-header` is only an inspection
option: it exposes merged configuration without initializing tools,
executing loaders, or expanding macros. Its output can contain configured
secrets; do not publish it as a diagnostic log.

Untrusted transcripts and prior public backend summaries are encoded in
one JSON fence longer than every backtick run in its payload. Tests run
hostile directives, links, macros, speaker delimiters, comments, and
Unicode through real parsing and macro processing, including replay.
This prevents parser-level execution, not model-level prompt injection.

The adapter requests a terminal result envelope:

````text
```lectic-live-result
{"status":"completed","summary":"The answer is 42."}
```
````

Allowed statuses are `completed`, `clarification`, and `failed`. The
nonempty summary is limited to 400 UTF-8 bytes, a conservative bound below
the 500-token append limit; see [CONTRACT.md](CONTRACT.md). The runner waits
for successful child completion and accepts only the terminal structured
answer. It does not forward intermediate prose, thought blocks, tools,
hooks, or raw stdout when extraction fails.

Completed results use a commentary append tied to the original delegation
ID. Acknowledgments, rejection, timeout, and disconnection are separate
from backend outcome. There is no blind resend. **Acknowledged does not
mean spoken or heard.** No model-authored progress is automatically sent.

## Limits, retention, and recovery

- Delegations settle for 750 ms, then execute serially. At most four are
  queued; requests older than 60 seconds expire without execution. Queue
  rejection/expiry is visible in diagnostics. The session retains at most
  256 delegation IDs, including rejected/cancelled tasks, so replay cannot
  revive them. Context clearing does not clear these execution tombstones.
- Task revisions advance for delegations/cancellation, independently of
  caption revisions. Fragments preserve exact text and receipt sequence;
  duplicate event IDs (or exact ID-less events) do not advance context.
  Identical text with different IDs/timestamps is not collapsed.
- Context keeps up to 96 recent fragments within 16,000 serialized bytes,
  plus eight public findings with bounded request excerpts, outcome,
  revision, run ID, and delivery state. The final envelope is capped at
  32 KiB. Fragment age and task receipt age are bounded by
  `--context-seconds`. This is recent context, not a complete log.
- A newer delegation or nonblank user speech during a run withholds its
  result. Speech alone never cancels or restarts the child, including
  backchannels such as “mm-hmm”. This conservative policy may withhold an
  otherwise useful answer; it does not pretend to infer semantic intent
  from a partial fragment. Already-sent commentary cannot be recalled.
- On the next delegation, Lectic receives the earlier finding and its
  request context, explicitly labeled as completed but withheld. Its prompt
  asks it to reconcile corrections, reuse applicable findings, investigate
  only missing/changed parts, and clarify ambiguous references. Distinct
  delegation IDs remain distinct requests. Semantic reuse depends on the
  backend following this contract; ID deduplication alone cannot prove that
  a model will never repeat a read-only tool call.
- Size/age eviction marks the context as incomplete instead of permanently
  blocking lookups. The backend can answer self-contained new requests and
  is instructed to clarify references that depend on missing context.
  This is a model-level judgment, not a guarantee of semantic correctness.
  Clear cancels queued/active work and resets working content, not archives
  or session-scoped execution IDs.
- Bootstrap accepts up to 128 browser event copies once. The controller
  deduplicates those against the attached sideband and subsequently uses
  only the sideband for backend execution. Event tracking is bounded.
- The server binds only to `127.0.0.1`, checks Host and Origin, and requires
  a per-launch bearer secret on controls. Captions and diagnostics are
  logged as inert console values. There are request-size, pending-control,
  and event-size limits.
- Loss of the browser heartbeat for 10 seconds triggers shutdown; loss of
  the sideband immediately blocks new backend work and attempts shutdown.
  A session with incomplete browser startup is also bounded. A failed media
  connection, closed data channel, or three seconds of disconnected WebRTC
  also requests End. No path recreates a paid session or replays work.
- The duration budget checks both wall-clock time from creation and Live's
  cumulative usage snapshots. Delayed snapshots cannot reduce provisional
  usage. The terminal snapshot is authoritative and late updates cannot
  replace it. Graceful close is idempotent and waits up to three seconds.
  End stops microphone tracks and playback immediately but keeps the peer
  transport until the controller's close attempt completes. Missing
  finalization is explicitly uncertain, not a claim that billing stopped.
- Voice cost is estimated at $0.05/minute, billed per second, with a
  15-second initialization charge credited against running time. Verify
  current pricing and access before testing. After a creation attempt the
  controller estimates at least 15 billable seconds, even if creation is
  uncertain.
  It is not an invoice and does not measure backend token costs.
- Children use process groups and bounded TERM/KILL cleanup. The tool PID
  namespace provides additional containment. Local cancellation does not
  prove remote provider cancellation or action rollback.
- Generation output/diagnostics are capped at 1 MiB, parsed records at
  4 MiB, and the seed at 512 KiB. Appends time out after five seconds.
- History is in memory by default; `--keep-history` and `--resume` retain
  local archives as described above. SIGKILL or a crash may also leave
  default temporary backend files. Lectic's script cache and provider-side
  retention remain independent. There is no raw audio recording.
- The browser logs bounded metadata-only lifecycle events and task states
  to the console, separately from transcript fragments. Local terminal errors
  and opted-in backend archives provide detailed diagnostics; they may contain
  sensitive
  content. Execution IDs remain session-scoped and are never replayed.

## QA checklist

1. Open the private URL: the page should show only a black radial spectrum
   on white and request microphone permission automatically. Exchange
   greetings; the console's backend run count should remain zero. Only agent
   speech should animate the spectrum, not your microphone input.
2. Ask for a concrete repository lookup, such as locating a function and
   explaining its callers. Check the audible answer against the files.
3. Correct the target during a deliberately slow lookup. Voice should stay
   responsive. Verify the old answer is withheld, the next delegation gets
   the old finding with its request context, and the audible answer refers
   to the corrected target. Test “mm-hmm” and ambiguous short replies too.
4. Ask for a repository write. Verify no host file changes. The backend
   should explain the read-only restriction rather than claim success.
5. Close the tab during a slow lookup. It should cancel local work and
   immediately remove the microphone indicator. Already-sent voice context
   cannot be recalled.
6. Test microphone denial and blocked autoplay. The page should stay
   control-free, with blockers logged to the console; clicking anywhere
   should retry playback without creating another session.
7. Test reload, closing while permission/startup is pending, and browser or
   network loss. No work should be silently resumed or repeated. Shutdown
   confirmation is distinct from local media cleanup; a dropped unload
   request relies on the watchdog rather than proving billing has stopped.

Live startup failures include HTTP status, known provider error codes, and
numeric sideband close codes. Local configuration/sandbox checks report
the underlying error, and backend failures print details to the terminal.
With history enabled, backend failure details are also saved in the run
directory. These local diagnostics may contain configuration or tool data;
review them before sharing. Raw errors are not spoken by GPT-Live.
Do not blindly retry a creation failure: it may already have been charged.
Backend failure, malformed results, or timeout produce a short failure
message rather than dumping raw tool output into speech.

## Automated checks and evidence

```sh
AGENT=1 bun test
tsc --noEmit
tsc --noEmit -p extra/plugins/lectic-live/tsconfig.json
eslint extra/plugins/lectic-live src/main.ts src/parseCmd.ts
```

The minimal UI update passed all 900 offline tests, root/plugin typechecks,
and the lint command above. Its embedded-script tests cover automatic
startup, permission/bootstrap gating, remote-only visualization, autoplay
retry, and teardown races. Browser
validation of the minimal UI is left to the user; the Chromium evidence
below describes the earlier control-based UI, not new browser QA.
Tests cover real CLI configuration, inert context replay, actual sandboxed
exec results, write denial, process cleanup, fake Live lifecycle, append
acknowledgments, authenticated controls, bootstrap, and delegation-only
execution. They require no API credentials; bwrap tests skip only where
Linux/Bubblewrap is absent, and ran in this validation environment.

Chromium page-shot checks captured desktop/mobile layouts and verified
computed layout, no horizontal overflow, secret removal, initial controls,
and mocked microphone denial. Installed Lectic script bundling was also
smoke-tested with the updated checkout backend CLI. These checks did not
capture real microphone audio or establish audible playback. The user
separately reported working browser use, including backend delegation;
the checklist above remains useful for focused lifecycle QA.

Slice 3 adds deterministic slow-lookup correction/reconciliation fixtures,
late acknowledgment/cancel races, retention gaps and clearing, queue limits
and expiry, terminal usage ordering, bounded HTTP bodies, ownership checks,
heartbeat cancellation, close idempotence, and startup error classification.
History tests cover private file modes, retained success/failure records,
bounded checkpoints, inert restored content, and new-session context reuse
without job replay. Retention eviction now marks incomplete context instead
of requiring Clear before every subsequent lookup.
Reconciliation tests prove the adapter supplies the right history and never
releases a stale result; they do not prove a real model's semantic choices.

Chromium slice 3 checks verified desktop and true 390 px mobile geometry,
no horizontal overflow, content clearing, mocked microphone denial, inert
caption text, diagnostic rendering, double-Start protection, and transport
release only after End completes. The page-shot helper needed an explicit
CDP viewport override because Chromium clamps its window width to 500 px.
No paid session or real microphone/playback test was performed for slice 3;
run the focused QA checklist before treating its audio gate as accepted.
