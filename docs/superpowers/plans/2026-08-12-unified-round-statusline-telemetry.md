# Unified Round StatusLine Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code statusLine and the 30-second SSE progress read the same current-model-round telemetry, while showing Proxy-wide session/active/wait counts beside `CC TOOL PROXY` and rendering elapsed seconds as integers.

**Architecture:** `RuntimeTelemetry` becomes the canonical owner of current round bytes, round start time, last semantic delta time, and 5-second rolling model throughput. Model round lifecycle hooks explicitly reset/close that state. Both statusLine HTTP output and SSE heartbeat consume the same request snapshot. Proxy-global counters remain separate and are attached to the status response/display.

**Tech Stack:** Node.js, Anthropic SSE parsing already present in the Proxy, Claude Code native statusLine command.

## Global Constraints

- Release version is `0.2.28.19`.
- Preserve the existing 30-second SSE heartbeat.
- Semantic bytes only: thinking/text/tool JSON delta payloads; raw wire bytes remain timeout/stall-only.
- No new Proxy-wide scheduler or queue.
- WAIT means explicit Proxy busy-retry wait, not the vLLM scheduler queue.
- Status icons are `▦` sessions, `▶` active, `⋯` waiting.
- Global counters appear immediately after `CC TOOL PROXY <version>`.
- All displayed seconds are whole integers.
- Preserve zh-TW, zh-CN, en-US, ja-JP, ko-KP support.

---

### Task 1: Canonical current-round telemetry

**Files:**
- Modify: `src/proxy/runtime-telemetry.js`
- Test: `test/runtime-telemetry.test.js`

**Interfaces:**
- Produces: `beginModelRound(requestId, { round, startedAt })`, `endModelRound(requestId, { endedAt })`, `snapshotRequest(requestId, now)`.
- `snapshotSession()` delegates active request values to the same current-round snapshot.

- [ ] Add failing tests proving Round 2 starts at 0 bytes, 0 B/s, and 0 round elapsed even after Round 1 produced data.
- [ ] Add failing tests proving a non-model phase does not expose stale previous-round bytes/rate.
- [ ] Implement the minimal round lifecycle and snapshot state.
- [ ] Run `node --test test/runtime-telemetry.test.js` and require all tests to pass.

### Task 2: Shared SSE/statusLine snapshot and Proxy-global counters

**Files:**
- Modify: `src/services/proxy-server.js`
- Modify: `src/i18n/response-language.js`
- Test: `test/proxy-server.test.js`
- Test: `test/response-language.test.js`

**Interfaces:**
- Consumes: `RuntimeTelemetry.snapshotRequest()` and `RuntimeTelemetry.snapshot()`.
- Produces status display shape `◆ CC TOOL PROXY <version> │ ▦ <sessions>   ▶ <active>   ⋯ <waiting> │ ...`.

- [ ] Add failing formatter test for global icons/counters and `59123ms -> 59s`.
- [ ] Add failing endpoint test requiring nested Proxy counters and round-scoped bytes.
- [ ] Wire every model-round start/end to RuntimeTelemetry.
- [ ] Make the 30-second model heartbeat consume `snapshotRequest()` for bytes/rate/elapsed/stall.
- [ ] Make status endpoint consume the same snapshot plus Proxy-global counters.
- [ ] Run targeted response-language/proxy-server tests.

### Task 3: Release metadata, documentation, packaging

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js`, `README.md`, `CHANGELOG.md`, `scripts/verify.sh`
- Create: `V0.2.28.19-更新說明.md`
- Test: release/deployment/version tests as required by existing repository conventions.

- [ ] Update all version metadata to `0.2.28.19`.
- [ ] Document unified round scope and the `▦ / ▶ / ⋯` global counters.
- [ ] Extend `verify.sh` with release-specific static contracts.
- [ ] Run full `npm test`, `npm run check`, and `sh scripts/verify.sh`.
- [ ] Package with `scripts/package.sh`, extract the ZIP, verify `MANIFEST.sha256`, archive integrity, versions, and rerun verification on extracted contents.
