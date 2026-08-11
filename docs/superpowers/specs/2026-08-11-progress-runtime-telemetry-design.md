# Progress Runtime Telemetry Design

## Goal

Upgrade VLLM-CC-TOOL-PROXY progress output from generic keepalive text into compact, localized runtime telemetry that communicates model phase, elapsed time, received bytes, recent upstream throughput, explicit vLLM busy waits, and post-first-byte stalls without changing model behavior or request scheduling.

## Scope

Version: `0.2.28.14`.

This release changes only Proxy-owned user-visible progress/status rendering and the supporting telemetry state. It does not change main-model admission, vLLM scheduling, retry policy, Final Language Gate semantics, Context Compact semantics, Vision inference behavior, or model prompts.

## Locales

Every new user-visible status must be provided through the existing response-language registry for all supported locales:

- `zh-TW`
- `zh-CN`
- `en-US`
- `ja-JP`
- `ko-KP`

Unknown locales continue to fall back to `en-US`.

## Progress header

The progress block header is a label only. It must never display a live received-byte value because the header may be emitted later than the state snapshot represented by the first progress line.

Examples:

```text
目前處理進度：
Current progress:
```

Per-state telemetry owns all byte counts.

## Main-model telemetry

A semantic heartbeat renders one compact physical line with:

- a universal state glyph
- localized phase text
- elapsed model-round time
- current per-round received bytes
- recent upstream receive rate when a meaningful rate sample exists

The display states are:

- `waiting`: upstream request is active but no model output phase has been identified.
- `thinking`: Anthropic thinking block/delta is active.
- `response`: visible text block/delta is active.
- `tool`: tool input/output construction is active.
- `stalled`: at least one upstream byte has already arrived, then no additional upstream byte has arrived for at least one progress-heartbeat interval.

`stalled` is observation only. It never cancels, retries, or resubmits a request.

Example zh-TW lines:

```text
◌ 主模型等待輸出 · 12s · 0 B
◐ 主模型思考中 · 42s · 28.4 KB · 0.7 KB/s
◆ 主模型回應中 · 57s · 39.8 KB · 0.6 KB/s
◇ 主模型建立工具動作 · 61s · 42.3 KB · 0.4 KB/s
⚠ 主模型資料暫停 · 30s 無新資料 · 總計 42.3 KB
```

## Pulse behavior

Thinking heartbeat glyphs rotate through `◐ ◓ ◑ ◒`. Rotation is derived from existing semantic-heartbeat samples. No new timer and no higher SSE update frequency are introduced.

Other phases use stable glyphs to avoid visual noise.

## Recent throughput

Throughput is measured between semantic-heartbeat samples using the current model-round byte counter:

```text
(current_round_bytes - previous_sample_bytes) / elapsed_sample_seconds
```

It is display telemetry only. Negative deltas or round changes reset the sample. A rate is omitted until a valid sample interval exists.

Use binary byte units and append `/s`.

## Stall detection

A round is `stalled` only when:

1. at least one upstream response byte has been received in the current round; and
2. `now - lastBaseResponseChunkAt >= progressHeartbeatMs`.

A request waiting for its first byte remains `waiting`, not `stalled`.

Explicit HTTP busy rejection remains the existing `VLLM BUSY` retry state and is never represented as `stalled`.

## Phase transitions

Immediate phase-change messages remain snapshot events, but use compact localized telemetry and phase glyphs. Their byte value is the byte count captured at the actual phase transition, so delayed progress visibility cannot produce contradictory header/state byte values.

## Auxiliary states

Existing Language Repair and Vision/media progress remain event-driven and localized. Their leading state vocabulary is upgraded to stable universal glyphs where practical:

- `◇` processor/auxiliary work (Language, Vision, Compact/media processing)
- `↻` explicit vLLM busy retry wait
- `⚠` observed upstream stall

No spinner frame generator is added for auxiliary processors.

## Context Compact

Context Compact remains outside the managed main-model telemetry stream in this release. Its existing transport contract is unchanged. This avoids wrapping native compact fallback in a second SSE lifecycle. The release may localize any existing compact-facing status if such a status is already emitted, but does not create a new compact progress channel.

## Diagnostics

Safe logs may include:

- phase
- elapsed milliseconds
- round received bytes
- recent throughput bytes/sec
- idle milliseconds since last upstream byte
- `stalled=true|false`

No model content is logged.

## Compatibility

- No new ENV variables.
- Existing `PROGRESS_HEARTBEAT_MS` controls both semantic heartbeat cadence and the minimum post-first-byte stall observation window.
- Existing vLLM explicit-busy 15-second retry behavior is unchanged.
- Progress text remains Proxy-owned and stripped from subsequent model history.
- Startup Session Banner behavior remains unchanged except optional localization of runtime labels if implemented through the same locale registry.
