# Managed Model Phase Progress Design

## Goal

Expose the current main-model generation phase during managed Anthropic SSE rounds without changing model behavior.

## Scope

Only managed model-generation progress changes. No reasoning-budget control, token-limit changes, media pipeline changes, final-language changes, continuation-state changes, or new environment variables.

## Observable phases

- `waiting`: no model content block has started yet.
- `thinking`: current model output is a `thinking` block or `thinking_delta`.
- `response`: current model output is a `text` block or `text_delta`.
- `tool`: current model output is a `tool_use`/`server_tool_use` block or `input_json_delta`.

Protocol-only events such as signatures, message deltas, block stops, and pings do not create user-visible phases.

## Progress copy

Heartbeat lines remain one physical line and are deliberately compact:

```text
主模型處理中 60 秒（思考，29.82 KB）…
主模型處理中 90 秒（回應，43.59 KB）…
主模型處理中 120 秒（工具，57.63 KB）…
```

Before a phase is known:

```text
主模型處理中 29 秒（等待，0 B）…
```

Phase transition notices are also compact single lines and emitted immediately when useful:

```text
主模型開始思考…
主模型開始回應…
主模型開始建立工具動作…
```

The byte value remains per-round upstream received bytes, not payload bytes for the named phase.

## Data flow

`collectAnthropicMessageFromSse()` emits an `onStreamPhase` callback when a meaningful content phase changes. `proxy-server.js` stores the current phase in `modelRoundProgress.phase`. The semantic-heartbeat factory reads that phase and renders the compact localized status. A new model round resets the phase to `waiting`.

## Diagnostics

Log phase changes as safe metadata only: request id, lane, round, previous phase, next phase, elapsed time, and per-round received bytes. No model content is logged.

## Compatibility

Non-SSE JSON managed responses keep existing behavior. Normal unmanaged passthrough streaming is unchanged. Existing first-byte accounting and continuation per-round byte reset remain authoritative.
