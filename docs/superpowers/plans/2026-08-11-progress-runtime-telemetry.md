# Progress Runtime Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver V0.2.28.14 compact multilingual progress telemetry with phase glyphs, elapsed time, per-round bytes, recent throughput, and non-invasive stall observation.

**Architecture:** Keep `ProgressStream` as the SSE transport and `response-language.js` as the sole user-visible localization registry. Add a small request-scoped model telemetry sampler in `proxy-server.js`; it derives heartbeat snapshots from existing byte counters and timestamps, while i18n renderers convert snapshots into locale-specific single-line statuses.

**Tech Stack:** Node.js 22+, native `node:test`, existing Anthropic SSE/progress pipeline.

## Global Constraints

- Release version is `0.2.28.14`.
- Support `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP` with `en-US` fallback.
- Do not add a main-model Proxy queue or change vLLM scheduling.
- Do not add a new animation timer; glyph pulse uses existing semantic heartbeat cadence only.
- Do not retry or cancel on stall telemetry.
- Do not place progress text into model context or token accounting.
- Do not add new ENV variables.

---

### Task 1: Localized telemetry rendering RED/GREEN

**Files:**
- Modify: `test/response-language.test.js`
- Modify: `src/i18n/response-language.js`

**Interfaces:**
- Consumes: `statusText(locale, key, values)` and `progressBlockHeader(locale)`.
- Produces: `modelTelemetry` and `modelPhaseChanged` localized renderers plus byte-rate formatting.

- [ ] Write failing tests proving progress headers never include live byte counts in all five locales.
- [ ] Write failing tests for waiting/thinking/response/tool/stalled telemetry in all five locales, including rate formatting.
- [ ] Run `node --test test/response-language.test.js` and confirm RED for the new expectations.
- [ ] Add the minimal shared byte-rate formatter and locale renderers.
- [ ] Run `node --test test/response-language.test.js` and confirm GREEN.

### Task 2: Request-scoped throughput and stall telemetry RED/GREEN

**Files:**
- Modify: `test/proxy-server.test.js`
- Modify: `src/services/proxy-server.js`

**Interfaces:**
- Consumes: `baseResponseBytes`, `lastBaseResponseChunkAt`, `modelRoundProgress`, `config.progressHeartbeatMs`.
- Produces: semantic heartbeat snapshot fields `recentBytesPerSecond`, `idleMs`, `stalled`, and `pulseIndex`.

- [ ] Write a failing integration test where two heartbeat samples receive increasing bytes and assert the later progress line contains a nonzero `/s` rate.
- [ ] Write a failing integration test where a first byte arrives and then no byte arrives for one heartbeat interval; assert a localized stalled line is emitted without an upstream retry.
- [ ] Run targeted proxy-server tests and confirm RED.
- [ ] Implement a per-round sampler that resets when model round/start byte changes and calculates recent byte rate from heartbeat samples.
- [ ] Derive stall only after first byte and one heartbeat interval of inactivity.
- [ ] Run targeted proxy-server tests and confirm GREEN.

### Task 3: Progress transport/header regression RED/GREEN

**Files:**
- Modify: `test/progress.test.js`
- Modify: `src/proxy/progress.js`

**Interfaces:**
- Consumes: `progressBlockHeader(locale)`.
- Produces: first visible progress block with a stable label-only header.

- [ ] Write a failing delayed-visibility test proving a phase snapshot byte value cannot be contradicted by a later live-byte header.
- [ ] Run `node --test test/progress.test.js` and confirm RED.
- [ ] Remove `getReceivedBytes()` from progress-header rendering while retaining it for diagnostics/other telemetry consumers if needed.
- [ ] Run `node --test test/progress.test.js` and confirm GREEN.

### Task 4: Busy and auxiliary glyph vocabulary

**Files:**
- Modify: `test/response-language.test.js`
- Modify: `src/i18n/response-language.js`

**Interfaces:**
- Produces: localized `↻` explicit-busy and `◇` Language/Vision processor progress without changing their state machines.

- [ ] Write failing assertions for glyph-prefixed busy, Language Repair, and Vision status in all five locales.
- [ ] Run the i18n test and confirm RED.
- [ ] Add glyphs only in locale renderers; do not change retry/processor control flow.
- [ ] Run the i18n test and confirm GREEN.

### Task 5: Release metadata and verification

**Files:**
- Modify: `src/version.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `V0.2.28.14-更新說明.md`
- Modify: release assertions in `test/version.test.js`, `test/deployment.test.js`, and `scripts/verify.sh` only where version/content expectations require it.

**Interfaces:**
- Produces: verified `vllm-cc-tools-proxy-v0.2.28.14.zip`.

- [ ] Update release metadata and documentation.
- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `bash scripts/verify.sh`.
- [ ] Package with `bash scripts/package.sh` and verify the extracted ZIP `MANIFEST.sha256` plus archive integrity.
