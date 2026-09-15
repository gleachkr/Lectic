# Live wire contract: stage 1 evidence

Rechecked against OpenAI's published guides and API reference on
2026-09-14. This is a small adapter for the `/v1/live` wire API, not a
Live SDK dependency. The installed OpenAI SDK is not used. The reference
publishes no more specific wire revision to pin; the date and offline
fixtures identify this snapshot. Contract discovery and automated tests
made no authenticated or paid calls. After slice 2 integration, the user
reported successful browser use, including backend delegation. This is
not a comprehensive live security or lifecycle acceptance test.

## Sources

Reference pages (the create page also exposes `index.md`):

- [Session creation][create]
- [Sideband events and commands][sideband]
- [Fork lifecycle][fork]

[create]:
  https://developers.openai.com/api/reference/resources/live/methods/create
[sideband]:
https://developers.openai.com/api/reference/resources/live/sideband-websocket
[fork]:
  https://developers.openai.com/api/reference/resources/live/fork-websocket

Guides:

- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
- https://developers.openai.com/api/docs/guides/voice-server-controls?api=live

## Confirmed shapes

Creation is `POST https://api.openai.com/v1/live/sessions` with a JSON
`session` plus `transport: {type: "webrtc", sdp: offer}`. The response has
`session.id` and `transport: {type: "webrtc", sdp: answer}`. Configure
`model: "gpt-live-1"`, `delegation: {type: "client"}`, and `store: false`.
WebRTC negotiates audio format: omit `audio.format`.

Create `oai-events` before the SDP offer, apply the answer, and wait for
`session.started`. Do not send `session.start` over WebRTC or on the
attached sideband. The trusted sideband attaches with project-key
authentication at:

```text
wss://api.openai.com/v1/live/sessions/{session_id}/attach
```

Transcript events are `session.input_transcript.delta` and
`session.output_transcript.delta`, with exact `delta`, `start_ms`, and
`end_ms`. Intervals may overlap across speakers. There is no transcript
item ID or authoritative turn-completed event.

`session.delegation.created` has event-level `offset_ms` and a nested
`delegation: {id, type: "delegation", target: "client" | "responses"}`.
The target can be Responses even though this plugin only handles client
work. IDs are opaque; reference examples themselves use different
prefixes. There is no task text or `request` field.

The adapter supports thinking, commentary, and instructions appends.
Each command has `type`, `event_id`, `delegation_id`, and plain-string
`content`. General context uses an explicit `delegation_id: null`.
The matching `session.<kind>.appended` acknowledgment has optional
`client_event_id`, plus timeline fields. Command rejection instead uses
nested `error.client_event_id`; `error.code` can be null. Missing
correlation IDs cannot resolve a pending append. No retry is automatic.
Acknowledgment does not establish speech, playback, or action completion.

`session.usage.updated` contains cumulative `usage.seconds`, not an
increment. `session.closed` includes final `usage.seconds`, a session
snapshot, and `reason`. A transport closing without this event leaves
final usage unconfirmed. Slice 2 tracks cumulative usage, requests close,
and waits up to three seconds for a terminal event before cleanup.
Acknowledged appends still do not establish playback.

The validators deliberately project only fields consumed by the plugin,
not every optional field in the Live reference. Extra fields and unknown
event types are inert; malformed supported fields throw. Reflected audio
is ignored. This is not a general-purpose Live SDK validator.

## Frontend permissions: explicit, not inferred

Creation supports startup-only:

```json
{
  "session": {
    "client": {
      "data_channel": {
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
    }
  }
}
```

Both fields also accept `"all"`. Omission preserves allow-all behavior;
an empty array allows none. Server event selectors are objects, not
strings. A `response.event` selector additionally requires a nested
`response_event`; that field is forbidden for other event types.
Trusted sideband connections are unaffected by these restrictions.

`createRequest` fixes the above policy. The browser cannot send appends,
update instructions, or close the session on its data channel. Browser UI
controls go through the authenticated local controller. Delegation
metadata is allowed to the browser only for display/bootstrap buffering;
it must never independently authorize execution. Session snapshots can
still expose configuration; the sideband is not a privacy boundary.

Slice 2 implements sideband-before-capture startup, authenticated
control, and a bounded, deduplicated bootstrap handoff. The sideband is
attached before the SDP answer is returned; microphone tracks are enabled
only after the authenticated handoff of `session.started`. Browser copies
after that handoff are ignored by the controller. These allowlists are
documented API behavior, not a claim of adversarially live-tested
enforcement.

## Result size

Appends have a documented 500-token content limit. The spike uses a
conservative 400 UTF-8 byte ceiling, not a character-count estimate. A
byte-level BPE encoding starts with bytes and merges them, so its token
count cannot exceed the byte count. Tests cover multibyte Unicode and
boundary rejection. No truncation or blind resend occurs.

This is intentionally restrictive and is not an exact GPT-Live token
counter. Recheck this assumption if the API changes tokenization; live
acceptance must still exercise server-side oversize rejection. The
backend should return short public findings, not split tool dumps across
multiple appends. Thinking appends are not private storage.

## Slice 3 lifecycle boundary

Task outcome and delivery are independent local state. A completed lookup
can be withheld, acknowledged, or uncertain without becoming a new lookup.
Task revisions do not advance merely because captions change. The next
client delegation carries prior request excerpts and findings to Lectic
for correction reconciliation. The plugin does not invent a Live task
completion event, semantically cancel from timing, or replay an old run.

Session close is idempotent and accepts terminal confirmation only from the
attached session's ID. Nonterminal usage cannot replace final usage. After
transport loss, local execution is blocked. A relaunch creates a new Live
session. Explicit `--resume ID` restores bounded backend context under the
same application conversation ID, never an execution queue or transport.
Opening the private URL automatically requests microphone permission, then
starts the paid session. The browser displays only an agent-audio spectrum;
status, transcript fragments, and diagnostics are console-only. Automatic
shutdown stops capture/playback immediately, retaining the peer until bounded
controller finalization. Closing/reloading the page releases the peer at once
and sends authenticated keepalive `/end`; the heartbeat watchdog covers lost
unload requests and browser crashes. Browser autoplay may require a click or
key press anywhere on the page; this never retries session creation.

Browser lifecycle diagnostics are metadata-only. Terminal setup/backend
errors and opt-in archives can contain detailed local data; they are for
the trusted machine owner and should be reviewed before sharing. Raw errors
and full backend records never become voice results. Local history does not
change Live's `store: false` setting or erase provider-side context.

`--keep-history` archives observed transcripts, checkpoints, and backend
records. `--resume` supplies a bounded context checkpoint as inert data to
Lectic on a new delegation. It does not fork/reconnect the old Live session,
restore unfinished tasks, or resend results. Read-only lookup resumption
needs context, not a transactional action journal. Future write recovery
still needs operation-state reconciliation before any retry.
