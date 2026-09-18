# Lectic Live adapter contract

Technical reference for the plugin's `/v1/live` wire adapter and Lectic CLI
boundary. For installation, operation, permissions, and retention, see the
[README](README.md). OpenAI details below remain unchanged. Gemini now has
a production PCM transport and delegation; see the
[transport notes](GEMINI_TRANSPORT.md) and
[delegation contract](GEMINI_DELEGATION.md) for bounds and limitations.
[History/lifecycle policy](GEMINI_LIFECYCLE.md) covers saved-context CLI
resume and local microphone wake after confirmed transport closure, with
remote finality and usage explicitly unknown. The checked wire contract
is in [GEMINI_CONTRACT.md](GEMINI_CONTRACT.md). The isolated stage 1 harness
is in [GEMINI_SPIKE.md](GEMINI_SPIKE.md).

## Session and browser transport

Create with `POST https://api.openai.com/v1/live/sessions`, using:

- `session`: `model: "gpt-live-1"`, `delegation: {type: "client"}`, and
  `store: false`.
- `transport`: `{type: "webrtc", sdp: offer}`.

The response supplies `session.id` and `transport.sdp`. WebRTC negotiates
audio format; omit `audio.format`. Create the `oai-events` data channel
before the SDP offer, apply the answer, and await `session.started`. Do not
send `session.start` on WebRTC or the sideband.

The controller attaches using the local project API key at:

```text
wss://api.openai.com/v1/live/sessions/{session_id}/attach
```

The sideband attaches before the SDP answer reaches the browser. Transmitted
microphone tracks stay disabled until the authenticated `session.started`
handoff. Bootstrap accepts at most 128 browser event copies, deduplicates
against the sideband, and ignores subsequent browser copies for execution.

Creation fixes `session.client.data_channel` to:

```json
{
  "allowed_client_events": [],
  "allowed_server_events": [
    { "type": "session.started" },
    { "type": "session.closed" },
    { "type": "session.usage.updated" },
    { "type": "session.input_transcript.delta" },
    { "type": "session.output_transcript.delta" },
    { "type": "session.delegation.created" },
    { "type": "error" }
  ]
}
```

These are provider-enforced data-channel restrictions, not tool permissions.
The trusted sideband is unaffected. Local lifecycle requests require the
controller's per-launch bearer secret, with Host/Origin checks and bounded
requests. Browser delegation metadata is not independent authorization.
Session snapshots can expose configuration; the sideband is not a privacy
boundary.

## Transcripts and delegation

`session.input_transcript.delta` and `session.output_transcript.delta`
carry `delta`, `start_ms`, and `end_ms`. Preserve text exactly, including
spaces. Speakers can overlap; there is no transcript item ID or
authoritative turn-completed event.

`session.delegation.created` contains event-level `offset_ms` and nested
`delegation: {id, type: "delegation", target: "client" | "responses"}`.
The adapter handles only client delegations. IDs are opaque. There is no
task text or `request` field: the adapter assembles context from transcripts
and prior backend outcomes.

Delegations settle for 750 ms before serialized execution. The queue holds
at most four requests; queued requests expire after 60 seconds. Each session
retains at most 256 delegation IDs, including rejected/cancelled work.
Context clearing does not remove these execution tombstones.

Working context holds up to 96 fragments within 16,000 serialized bytes
and eight findings with bounded request excerpts and task/delivery state.
`--context-seconds` bounds fragment and task receipt age. The final envelope
is capped at 32 KiB; evictions mark incomplete context for clarification.
Task revisions are independent of transcript revisions. New nonblank user
speech or delegation during work withholds delivery, not execution.
Subsequent delegations receive recent outcomes for reconciliation, including
uncertain failed/cancelled work. Semantic reuse depends on the backend;
deduplication is not an exactly-once action guarantee.

## Lectic input and results

Generation uses `lectic -f SEED --no-macros --format full`, with the adapter
prompt and context on stdin, followed by EOF. The seed is not overwritten.
The invocation directory and seed configuration base are preserved, including
relative imports and `LECTIC_FILE`. Configuration is not flattened or
capability-filtered.

Generated context is JSON inside a fence longer than any backtick run in
its payload. Macro suppression leaves all user-message directives literal;
it does not disable tools, hooks, executable sources, or attachment loads.

The completed record is parsed on stdin from the seed directory, not with
`-f` pointing into managed state. Parsing does not initialize tools or
execute loaders. Only a terminal structured answer after successful child
completion is eligible for delivery:

````text
```lectic-live-result
{"status":"completed","summary":"The answer is 42."}
```
````

The object has exactly `status` and `summary`. Status is `completed`,
`clarification`, or `failed`; summary is nonempty public text of at most
16 KiB of UTF-8 text. Malformed results never fall back to raw stdout,
intermediate prose, thought blocks, or tool records. No model-authored
progress is automatically forwarded.

Generation output/diagnostics are capped at 1 MiB, parsed records at 4 MiB,
and the seed at 512 KiB. Backend timeouts apply per subprocess phase.
Children use process groups with bounded TERM/KILL cleanup; tools escaping
those groups require their own containment.

## Appends and acknowledgment

The adapter supports `session.thinking.append`, `session.commentary.append`,
and `session.instructions.append`. Each carries `event_id`, `delegation_id`,
and plain-string `content`. General context uses `delegation_id: null`;
backend commentary uses the original delegation ID.

OpenAI appends have a 500-token API limit. The per-append conservative
400-byte ceiling assumes byte-level BPE, not an exact GPT-Live token count.
Recheck that assumption if tokenization changes. Public results longer than
400 bytes are split at Unicode code-point boundaries into numbered parts,
with at most 340 bytes of content plus the part label. Each part is sent once
and acknowledged before the next; failure stops delivery without retries.
Only the validated public summary is split, never raw output or tool dumps.
The voice prompt asks for the final part before explaining the result.
Gemini sends the entire public result in one function response. Its wire
bound permits the shared 16 KiB result plus the adapter's status prefix.
Thinking appends are not private.

Match `session.<kind>.appended.client_event_id` to the outgoing `event_id`.
Rejections instead use `error.client_event_id`; `error.code` may be null.
Missing correlation IDs cannot resolve an append. Appends time out after
five seconds, with no blind resend. Task outcome and delivery state are
independent: acknowledgment proves neither playback nor action completion.

Validators project only consumed fields. Unknown events and extra fields
are inert; malformed supported fields throw. Reflected audio is ignored.

## Close, idle replacement, and resume (OpenAI)

Send `session.close` and wait up to three seconds for `session.closed`.
Close is idempotent; terminal confirmation must match the attached session.
`session.usage.updated.usage.seconds` is cumulative, not incremental.
`session.closed` supplies final usage, a session snapshot, and `reason`.
Final usage overrides provisional usage; later updates cannot replace it.
Transport loss without terminal confirmation leaves finalization uncertain
and blocks new work. Explicit creation rejections (HTTP 400, 401, 403,
404, 422, or 429) remove the new speculative minimum and preserve prior
confirmed usage. Timeouts, server errors, and attachment failures remain
uncertain. Neither class of startup failure is automatically retried.
Diagnostics expose only allowlisted error codes/types and schema paths,
never raw provider messages.

Authenticated `/idle` is session-bound, rejects pending work/recent speech,
and requires confirmed close before replacement. Only cloned microphone
tracks enter WebRTC; local RMS analysis remains active while idle. Wake
waits for close to finish and creates a fresh coordinator and bootstrap.
Retired callbacks cannot affect the new owner. Page close, heartbeat loss,
startup failure, and unexpected transport loss are terminal, not wake paths.

Idle wake and CLI resume share bounded checkpoints, never an execution queue.
Creation's `session.input` accepts up to 128 messages and 8,192 rendered
tokens, with one content part per message. The adapter emits
`type: "message"` items with user `input_text` or assistant `output_text`
content parts. It joins adjacent same-speaker deltas without changing their
text and caps serialized input at 8 KiB.
History is not developer instructions or pending work. Task outcomes go to
Lectic on new delegation; no prior job or result is automatically replayed.
Provider-native recording/forking is not enabled.

Usage sums sessions and their separate 15-second minimums. The budget
excludes disconnected idle time, not startup/close time; each wake requires
room for its minimum. Terminal snapshots remain authoritative per session.

## Gemini history, replacement, and accounting

CLI `--resume` and microphone wake use the same v1 text checkpoint. Gemini
sets `historyConfig.initialHistoryInClientContent: true`, waits for
`setupComplete`, sends one text-only `clientContent` batch with
`turnComplete: true`, and only then permits microphone PCM. The special
history handshake is documented not to trigger generation. Ordinary
`clientContent` updates do not have that guarantee and are not used here.

The encoded history message is capped at 8 KiB and 128 turns. Only user and
assistant fragments become user/model turns; exact adjacent deltas from
one owner are joined. Task outcomes/findings are inert JSON text, never wire
function calls or responses. Old speech is dropped before task context;
omissions are marked. History is untrusted, not new instructions or work.
There is no separate provider history-accepted acknowledgment.

Normal idle requires no pending execution or completion notification.
Recovery aborts local work and awaits cleanup and confirmed transport closure
before allowing a new owner. GoAway/provider loss never automatically creates
that owner. Explicit End, page/heartbeat loss, time limits, startup failure,
invalid local protocol and unconfirmed closure are terminal. Retired event
and audio callbacks cannot affect a replacement. Local closure/cancellation
does not establish remote finality, action rollback or final usage.

Gemini reports latest partial token counters, not a cross-session total or
cost estimate. Up to 64 prior connection reports are retained separately.
The cumulative connection-time cap includes startup/shutdown and local
cleanup, excludes parked time, and survives wakes within the launch. It
applies no OpenAI minimum. A new CLI launch has a fresh budget; this is not
a strict spending cap. See the lifecycle runbook for acceptance checks.

Archives remain v1 and old checkpoints remain readable. New `session.json`
metadata identifies the chosen provider/model but never chooses startup
credentials or configuration. Cross-provider resume creates a fresh session;
no job, result, audio, native resumption handle or connection is replayed.

## API references

- [Session creation][create]
- [Sideband events and commands][sideband]
- [Client delegation][delegation]
- [Conversation history][conversations]
- [WebRTC][webrtc]
- [Server controls][controls]

[create]:
  https://developers.openai.com/api/reference/resources/live/methods/create
[sideband]:
https://developers.openai.com/api/reference/resources/live/sideband-websocket
[delegation]: https://developers.openai.com/api/docs/guides/live-delegation
[conversations]:
  https://developers.openai.com/api/docs/guides/live-conversations
[webrtc]: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
[controls]:
  https://developers.openai.com/api/docs/guides/voice-server-controls?api=live

## Controller lifetime and launch output

A launch prints only its private URL on stdout and never opens a browser.
Diagnostics go to stderr. Redirected stdout uses a detached controller and
a short-lived launcher so shell command substitution completes immediately.
Interactive launches remain in the foreground for Ctrl-C.

Authenticated `/close` ends the session and stops the listener after cleanup;
pagehide uses a keepalive request to that endpoint. Missing heartbeats also
stop the listener and controller, even before paid startup or while idle.
`/end` still permits final diagnostics until tab close or heartbeat expiry.
No browser attachment means the controller stays ready without paid usage.
Backend exceptions are converted into safe failure results for the voice
model. They do not terminate the controller or automatically retry work.
