# Progress Live-Line Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a carriage-return based live progress line so semantic heartbeat telemetry updates in place while phase milestones remain visible, with all existing locales preserved.

**Architecture:** `ProgressStream` will distinguish immutable milestone deltas from replaceable live-line deltas. Live updates use `\r` plus conservative trailing-space padding and never use ANSI CSI sequences; when a milestone arrives after a live line it first commits a newline, then appends the milestone. Existing progress-history stripping remains header-based and therefore removes control-bearing progress blocks before model reuse.

**Tech Stack:** Node.js 22, Anthropic SSE text deltas, node:test.

## Global Constraints

- Version: `0.2.28.15`.
- Preserve locales: `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, `ko-KP`; unknown locale falls back to `en-US`.
- Do not add Proxy-wide scheduling or retry behavior.
- Do not increase heartbeat frequency; animation changes only when an existing heartbeat fires.
- Do not use ANSI cursor-up / erase sequences in this version; use carriage return only.
- Progress content must remain removable by `stripProgressHistory()` and must not enter model context.

---

### Task 1: Live-line SSE renderer

**Files:**
- Modify: `src/proxy/progress.js`
- Test: `test/progress.test.js`

**Interfaces:**
- Consumes: `ProgressStream.update(message, options)` and semantic heartbeat events.
- Produces: `options.renderMode` supporting `"live"` and `"milestone"`; semantic heartbeats default to live mode.

- [ ] Write failing tests for carriage-return replacement, milestone-after-live transition, shorter-line padding, and history stripping.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement minimal live-line state in `ProgressStream`.
- [ ] Run targeted tests and confirm GREEN.

### Task 2: Model progress integration and i18n preservation

**Files:**
- Modify: `src/services/proxy-server.js`
- Test: `test/proxy-server.test.js`, `test/response-language.test.js`

**Interfaces:**
- Consumes: model phase-change milestones and semantic heartbeat telemetry.
- Produces: phase transitions as immutable milestones; heartbeat telemetry as replaceable live lines.

- [ ] Add failing integration assertions for milestone/live ordering and all locale telemetry.
- [ ] Run targeted tests and confirm RED.
- [ ] Wire model phase milestones and heartbeat live updates without new timers.
- [ ] Run targeted tests and confirm GREEN.

### Task 3: Release metadata, docs, and verification

**Files:**
- Modify: `package.json`, `src/version.js`, `CHANGELOG.md`, `README.md`
- Create: `V0.2.28.15-更新說明.md`
- Test: release/deployment/version tests.

**Interfaces:**
- Produces: clean `vllm-cc-tools-proxy-v0.2.28.15.zip` release.

- [ ] Update version and documentation.
- [ ] Run full `npm test`, `npm run check`, and `sh scripts/verify.sh`.
- [ ] Package, extract, verify `MANIFEST.sha256`, run `unzip -t`, and compute SHA256.
