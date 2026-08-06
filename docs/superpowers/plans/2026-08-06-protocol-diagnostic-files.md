# Protocol Diagnostic Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist complete redacted protocol anomaly evidence in atomic timestamped temporary files while keeping the main log compact.

**Architecture:** Extend diagnostic collectors with an opt-in full-redacted-field mode, add a focused filesystem store, and pass a writer callback into the managed loop. The server owns request IDs and maps successful writes to one content-free log event.

**Tech Stack:** Node.js 22 ESM, node:test, node:fs/promises, SHA-256.

## Global Constraints

- Keep `LOG_PROTOCOL_SNIPPETS` as the only feature switch.
- Do not change Managed Loop or repair decisions.
- Diagnostic file failures must never fail the user request.
- Main logs must never contain protocol snippets when the feature is enabled.
- Persist only redacted content.

---

### Task 1: Diagnostic file store

**Files:**
- Create: `src/proxy/protocol-diagnostic-store.js`
- Create: `test/protocol-diagnostic-store.test.js`

**Interfaces:**
- Produces: `ProtocolDiagnosticStore.write(bundle): Promise<{file_path,file_bytes,file_sha256,created_at}>`

- [ ] Write failing tests for timestamped names, atomic completion, private permissions, JSON payload and SHA-256.
- [ ] Run the focused test and confirm failure because the module does not exist.
- [ ] Implement the minimal atomic store.
- [ ] Run focused tests and confirm success.

### Task 2: Full redacted evidence collection

**Files:**
- Modify: `src/proxy/protocol-diagnostics.js`
- Modify: `test/protocol-diagnostics.test.js`

**Interfaces:**
- Produces: optional `full_text_redacted` fields when `{includeFullText:true}` is supplied.

- [ ] Write failing tests proving complete fields are opt-in and credentials are redacted.
- [ ] Run focused tests and confirm expected failure.
- [ ] Add the opt-in collector behavior.
- [ ] Run focused tests and confirm success.

### Task 3: Managed-loop file handoff

**Files:**
- Modify: `src/proxy/managed-loop.js`
- Modify: `test/managed-loop.test.js`

**Interfaces:**
- Consumes: `writeProtocolDiagnostics(bundle)` callback.
- Produces: safe file metadata diagnostic events only.

- [ ] Replace expectations for per-snippet log events with a failing writer-callback contract test.
- [ ] Confirm RED.
- [ ] Implement writer handoff, safe success event and non-fatal failure event.
- [ ] Confirm focused tests pass.

### Task 4: Server integration and runtime path

**Files:**
- Modify: `src/config.js`
- Modify: `src/services/proxy-server.js`
- Modify: `test/config.test.js`
- Modify: `test/proxy-server.test.js`

**Interfaces:**
- Produces: internal `protocolDiagnosticsDir` and request-scoped writer callback.

- [ ] Write failing tests for default temporary path and integration file creation without snippet leakage to logs.
- [ ] Confirm RED.
- [ ] Wire the store into the server.
- [ ] Confirm focused tests pass.

### Task 5: V0.2.13 release contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `V0.2.13-更新說明.md`
- Modify: version/deployment tests.

- [ ] Write/update failing version and documentation contract tests.
- [ ] Confirm RED.
- [ ] Update version and operator documentation, including `docker cp` retrieval.
- [ ] Run full tests and syntax checks.
- [ ] Build and independently verify the release ZIP and SHA-256.
