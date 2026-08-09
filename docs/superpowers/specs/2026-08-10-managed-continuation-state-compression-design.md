# Managed Continuation State Compression Design

## Goal

Improve controlled continuation recovery so a long incomplete managed round does not lose most of the model's working state before the recovery round.

## Scope

This mechanism runs **only after the existing managed-final gate has already selected `continuation` recovery**. It does not participate in normal managed rounds, valid tool-use rounds, valid final answers, deterministic final promotion, or final-channel recovery.

Only model-generated working state from the immediately preceding invalid round is eligible:

- `thinking` block text
- unfinished visible `text` block text

The compressor must never receive:

- user/system messages
- tool definitions
- `tool_use`
- `tool_result`
- Read/Bash/WebSearch/WebFetch content
- PDF/Vision/media evidence
- any serialized copy of the original conversation

The original conversation remains untouched and authoritative. The compacted state is appended only as non-authoritative prior model working state.

## State Preparation Policy

After control-tag neutralization, classify by character count:

- SMALL: `<= 24,000` chars → preserve the whole sanitized state.
- MEDIUM: `24,001..96,000` chars → deterministic HEAD+TAIL preservation; no external processor call.
- LARGE: `> 96,000` chars → overlapping segmented external compression when the existing auxiliary processor is available; otherwise deterministic fallback.

Deterministic fallback budget:

- head: 8,000 chars
- recent tail: 16,000 chars
- omission marker between them when truncated

The recent raw model-state tail is always retained for LARGE state even when external compression succeeds.

## Large-State Segmentation

Large model state is split into overlapping character windows:

- context window target: 24,000 chars
- overlap: 4,000 chars
- primary stride: 20,000 chars

Each compressor call receives only one model-state window and explicit range metadata. Overlap exists only to preserve cross-boundary semantics. Compressor output must describe model working state, not verified facts.

## External Processor

Reuse the existing `WEB_FETCH_PROCESSOR_*` provider/url/model/auth/timeout/concurrency contract. No new ENV variables are introduced.

The external model acts only as a state extractor/compressor. It must not perform new reasoning, tool selection, factual verification, or tool calls.

Each segment returns a strict JSON object with these arrays:

- `working_assumptions`
- `decisions_considered`
- `rejected_options`
- `unresolved_items`
- `intended_next_actions`

Each item is plain text derived only from the supplied model-state segment. No `confirmed_facts` field is allowed.

The proxy validates JSON and rejects tool-call attempts. Segment failures degrade to deterministic fallback instead of failing the managed request.

## Merge

Segment outputs are merged deterministically:

- preserve category order
- normalize whitespace for identity comparison
- deduplicate exact normalized duplicates caused by overlap
- cap compressed history to 20,000 chars
- append recent sanitized raw tail up to 12,000 chars

The final continuation handoff therefore targets roughly 32K chars and remains bounded.

## Recovery Request

Continuation recovery keeps the original request conversation, tools, and tool choice. It disables thinking as today.

The appended instruction labels the compacted material as:

`Prior model working state (non-authoritative; original conversation and tool evidence remain authoritative)`

The recovery instruction tells the model to continue rather than restart, but to rely on the original conversation for factual/tool evidence.

## Progress and Diagnostics

When continuation is selected, visible progress must state that prior work is being preserved rather than discarded.

For LARGE state:

- before compression: show that the proxy is organizing the previous model working state
- after preparation: show produced chars and preserved handoff size

Diagnostics:

- `managed_continuation_state_preparation_started`
- `managed_continuation_compression_chunk_started`
- `managed_continuation_compression_chunk_completed`
- `managed_continuation_compression_failed`
- `managed_continuation_state_preserved`

Safe fields include candidate chars, mode, chunk count, range offsets, compressed chars, recent-tail chars, handoff chars, deduplicated item count, and fallback reason. Raw working state and compressed content are never logged.

## Failure Contract

External compression is best-effort only.

Any unavailable processor, timeout, HTTP error, invalid JSON, malformed schema, empty output, or tool-call attempt falls back to deterministic HEAD+TAIL. Controlled continuation itself must still proceed.

## Versioning

Release version: `0.2.28.5`.

No media/vision/evidence semantics change, so cache generations remain:

- `media-v7`
- `visual-v10`
- `evidence-v6`

## Acceptance Criteria

1. Normal valid managed rounds never invoke the continuation compressor.
2. Final-channel recovery never invokes the continuation compressor.
3. Compressor input is built only from `thinking` and visible `text` blocks of the invalid managed response.
4. SMALL state is fully preserved without an external call.
5. MEDIUM state uses deterministic HEAD+TAIL without an external call.
6. LARGE state uses overlapping 24K windows with 4K overlap when the external processor is available.
7. LARGE-state compressor failure falls back without failing the request.
8. Tool/tool-result/evidence text cannot appear in compressor input merely because it exists in the original conversation.
9. Recovery UI reports that prior work was preserved and indicates the preserved state size.
10. No new ENV variables are added.
