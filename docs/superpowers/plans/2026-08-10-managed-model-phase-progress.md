# Managed Model Phase Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compact one-line `等待 / 思考 / 回應 / 工具` progress observability for managed main-model SSE rounds.

**Architecture:** Extend the existing Anthropic SSE collector with a phase callback, keep phase state per managed round in the proxy server, and render the current phase through localized heartbeat text. Phase detection is derived only from SSE block/delta types and never from model-content heuristics.

**Tech Stack:** Node.js ESM, Anthropic SSE, existing ProgressStream/i18n modules, `node:test`.

## Global Constraints

- Version: `0.2.28.7`.
- No new environment variables.
- Do not change model sampling, reasoning budgets, continuation behavior, media behavior, or final-language behavior.
- Every heartbeat status is one physical line and more concise than v0.2.28.6.
- Bytes shown are per-round upstream bytes.
- Cache generations remain `media-v7 / visual-v10 / evidence-v6`.

---

### Task 1: SSE phase callback

**Files:**
- Modify: `src/proxy/anthropic-sse-collector.js`
- Test: `test/anthropic-sse-collector.test.js`

**Interfaces:**
- Produces: `onStreamPhase({ phase, previous_phase, event, block_type, delta_type })`.

- [ ] Write failing tests for thinking→response→tool phase transitions and duplicate suppression.
- [ ] Run focused collector tests and verify RED.
- [ ] Implement the minimal phase mapper/callback.
- [ ] Run focused collector tests and verify GREEN.

### Task 2: Managed progress phase state and compact copy

**Files:**
- Modify: `src/services/proxy-server.js`
- Modify: `src/i18n/response-language.js`
- Test: `test/response-language.test.js`
- Test: `test/proxy-server.test.js`

**Interfaces:**
- Consumes: collector `onStreamPhase`.
- Produces: per-round `modelRoundProgress.phase` and compact localized model heartbeat text.

- [ ] Write failing copy/state-transition tests.
- [ ] Run focused tests and verify RED.
- [ ] Reset phase to waiting on every managed round and update it from SSE phase callbacks.
- [ ] Emit immediate compact transition status and phase metadata diagnostics.
- [ ] Run focused tests and verify GREEN.

### Task 3: Release metadata and verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js`, `README.md`, `CHANGELOG.md`, `scripts/verify.sh`
- Create: `V0.2.28.7-更新說明.md`
- Test: `test/version.test.js`, release/deployment assertions as applicable.

- [ ] Write/update release assertions for v0.2.28.7.
- [ ] Run release tests and verify RED before version metadata change.
- [ ] Update release metadata/docs without changing cache generations or ENV contract.
- [ ] Run full `npm test`, `npm run check`, and `scripts/verify.sh`.
- [ ] Package, regenerate `MANIFEST.sha256`, verify ZIP integrity/path layout/SHA256.
