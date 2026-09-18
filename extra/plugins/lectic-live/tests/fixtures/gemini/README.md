# Gemini stage 0 fixtures

These are small, synthetic examples derived from the sources reviewed in
[the contract](../../../GEMINI_CONTRACT.md), NOT captured provider traffic.
Nothing here demonstrates endpoint acceptance, audio quality, transcript
delta semantics, or successful delegation. No credentials or real audio are
included. PCM examples are two fabricated samples, not speech.

`contract.json` contains:

- `client`: exact outgoing shapes proposed for the opt-in spike.
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
choices. It deliberately does NOT implement a test-only Gemini parser or
claim to verify the rejection expectations. Stage 1 now exercises all server
examples and server-side malformed cases through the actual spike codec in
`gemini-wire.test.ts`, with generated bounds and lifecycle/socket tests in
the other `gemini-*.test.ts` files. Production coordinator and transport
coverage remains stage 3/4 work, not a claim made by the corpus checks.

Do not import live startup modules, read credentials, connect sockets, or
capture a microphone from these offline checks.
