# Gemini wire fixtures

These are small, synthetic examples of the supported wire shapes, based on
[Gemini's Live API](https://ai.google.dev/gemini-api/docs/live), NOT captured
provider traffic.
Nothing here demonstrates endpoint acceptance, audio quality, transcript
delta semantics, or successful delegation. No credentials or real audio are
included. PCM examples are two fabricated samples, not speech.

`contract.json` contains:

- `client`: example outgoing shapes, including history and results.
- `server`: consumed event shapes and inert optional-field examples.
- `malformed`: inputs an adapter must reject, or outgoing mistakes its
  builders must never produce. `path` identifies the consumed field at issue.
  Missing call IDs are unsafe for this plugin even though the shared API
  schema marks them optional. This is local policy, not a provider rule.
- `sequences`: ordered fixture IDs and required interpretation. They expose
  races and missing guarantees; they are not observed provider sequences.

The serialized corpus is capped at 64 KiB; each wire example is at most
4 KiB.
Large-message, queue, and frame-boundary tests should generate their inputs,
not check in audio-sized blobs. Unknown optional fields are inert, even when
shaped unexpectedly; malformed fields we actually consume must fail closed.
Missing optional counters/text are not synthesized into stronger evidence.

`gemini-fixtures.test.ts` checks corpus integrity and pins selected wire
choices. It deliberately does NOT implement a test-only Gemini parser.
`gemini-wire.test.ts` exercises server examples and malformed cases through
the production decoder; other `gemini-*.test.ts` files cover the adapter,
coordinator and transport. These tests do not establish live provider
acceptance.

Do not import live startup modules, read credentials, connect sockets, or
capture a microphone from these offline checks.
