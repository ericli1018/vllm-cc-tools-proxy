# Protocol Anomaly Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, redacted, structured context snippets for managed final-response anomalies and their input protocol provenance.

**Architecture:** A focused protocol-diagnostics module traverses response/request strings, locates protocol tags, creates bounded redacted snippets and fingerprints, and is called only by the managed final-response path. Configuration exposes one boolean and proxy logging preserves safe defaults.

**Tech Stack:** Node.js 22 ESM, node:test, structured JSON logs.

## Global Constraints

- Detailed content logging is disabled by default.
- Never log authentication secrets.
- Do not log complete prompts, complete pages or complete model responses.
- Preserve the existing one-repair final-response policy.

---

### Task 1: Diagnostic extraction module

**Files:**
- Create: `src/proxy/protocol-diagnostics.js`
- Test: `test/protocol-diagnostics.test.js`

**Interfaces:**
- Produces: `collectResponseAnomalySnippets(response, inspection)` and `collectRequestProtocolSnippets(request)`.

- [ ] Write failing tests for tag context, line/column, thinking excerpts and redaction.
- [ ] Run focused tests and confirm missing-module failure.
- [ ] Implement bounded traversal, redaction and fingerprints.
- [ ] Run focused tests to green.

### Task 2: Managed loop diagnostics

**Files:**
- Modify: `src/proxy/managed-loop.js`
- Test: `test/managed-loop.test.js`

**Interfaces:**
- Consumes: diagnostic collectors from Task 1.
- Produces: anomaly and input-provenance diagnostic events when `logProtocolSnippets` is true.

- [ ] Write failing tests for original/repaired anomaly events and disabled behavior.
- [ ] Run focused tests to verify failure.
- [ ] Emit detailed events before repair and rejection.
- [ ] Run focused tests to green.

### Task 3: Configuration and proxy integration

**Files:**
- Modify: `src/config.js`
- Modify: `src/services/proxy-server.js`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Test: `test/config.test.js`
- Test: `test/proxy-server.test.js`
- Test: `test/deployment.test.js`

**Interfaces:**
- Produces: `config.logProtocolSnippets: boolean` from `LOG_PROTOCOL_SNIPPETS`.

- [ ] Write failing configuration, deployment and log-integration tests.
- [ ] Run focused tests to verify expected failures.
- [ ] Wire the opt-in flag through the managed loop and emit snippet events at warning level.
- [ ] Run focused tests to green.

### Task 4: Release V0.2.12

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `V0.2.12-更新說明.md`
- Modify: release verification scripts/manifests as required by existing project conventions.

- [ ] Update version and documentation.
- [ ] Run full tests and syntax checks.
- [ ] Run deployment/static release verification.
- [ ] Commit, tag `v0.2.12`, create ZIP and SHA-256.
- [ ] Extract ZIP independently and repeat verification.
