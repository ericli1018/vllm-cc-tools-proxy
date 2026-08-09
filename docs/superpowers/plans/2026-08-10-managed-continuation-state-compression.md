# Managed Continuation State Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recovery-only bounded model working-state compression for controlled continuation without exposing tool/evidence content to the compressor.

**Architecture:** Extract only the invalid round's `thinking` and visible `text`, sanitize it, select SMALL/MEDIUM/LARGE preparation, and optionally compress LARGE state through the existing external auxiliary processor using overlapping windows. Merge structured compressor output deterministically, append recent raw model state, then build the existing non-thinking continuation request on top of the untouched original conversation.

**Tech Stack:** Node.js ESM, built-in fetch, existing managed loop, existing WEB_FETCH_PROCESSOR configuration/admission lane, node:test.

## Global Constraints

- Version is `0.2.28.5`.
- Compression runs only after the existing gate selects `continuation` recovery.
- Compressor input is model-generated `thinking` + visible `text` only.
- Never send tool definitions, tool calls, tool results, media/PDF/Vision evidence, user messages, system prompts, or the serialized original conversation to the compressor.
- Reuse existing `WEB_FETCH_PROCESSOR_*`; add no ENV variables.
- SMALL `<=24000`: preserve all.
- MEDIUM `24001..96000`: deterministic HEAD 8000 + TAIL 16000.
- LARGE `>96000`: 24000-char windows, 4000-char overlap, external compression if available, deterministic fallback otherwise.
- External compression failure must not fail the managed request.
- Cache generations remain `media-v7 / visual-v10 / evidence-v6`.

---

### Task 1: Working-state preparation primitives

**Files:**
- Create: `src/proxy/continuation-state.js`
- Test: `test/continuation-state.test.js`

**Interfaces:**
- Produces `extractModelWorkingState(response) -> string`.
- Produces `planContinuationState(candidate) -> { mode, candidateChars, windows, fallbackText }`.
- Produces `mergeCompressedContinuationState(outputs, recentTail) -> { text, deduplicatedItems, compressedChars, recentTailChars }`.

- [ ] **Step 1: Write failing tests** for thinking/text-only extraction, tool block exclusion, SMALL full preservation, MEDIUM HEAD+TAIL, LARGE 24K/4K overlap windows, and deterministic dedup merge.
- [ ] **Step 2: Run** `node --test test/continuation-state.test.js` and confirm RED for missing module/functions.
- [ ] **Step 3: Implement minimal primitives** with constants `SMALL_MAX_CHARS=24000`, `LARGE_MIN_CHARS=96001`, `WINDOW_CHARS=24000`, `OVERLAP_CHARS=4000`, `MEDIUM_HEAD_CHARS=8000`, `MEDIUM_TAIL_CHARS=16000`, `LARGE_RECENT_TAIL_CHARS=12000`, and compressed-history cap `20000`.
- [ ] **Step 4: Re-run** the focused test and confirm PASS.

### Task 2: External continuation compressor

**Files:**
- Create: `src/services/continuation-state-compressor.js`
- Test: `test/continuation-state-compressor.test.js`

**Interfaces:**
- Consumes one prebuilt model-state window plus existing processor config.
- Produces validated structured state object arrays only.
- Exposes `compressContinuationWindow(window, options)`.

- [ ] **Step 1: Write failing tests** for OpenAI-compatible request shape, Ollama/vLLM think-off controls, JSON validation, tool-call rejection, timeout/error normalization, and strict schema categories.
- [ ] **Step 2: Run** `node --test test/continuation-state-compressor.test.js` and confirm RED.
- [ ] **Step 3: Implement compressor client** using the existing processor URL/model/auth/timeout and `acquireProcessor`, with no tools supplied and no new ENV.
- [ ] **Step 4: Re-run** focused tests and confirm PASS.

### Task 3: Recovery-only managed-loop integration

**Files:**
- Modify: `src/proxy/managed-final.js`
- Modify: `src/proxy/managed-loop.js`
- Modify: `src/services/proxy-server.js`
- Test: `test/managed-loop.test.js`

**Interfaces:**
- `buildManagedContinuationRecoveryRequest` accepts prepared state text instead of internally truncating to 4000 chars.
- `runManagedLoop` receives optional `prepareContinuationState` dependency used only for `recovery.route === 'continuation'`.

- [ ] **Step 1: Write failing regression tests** proving valid tool/final rounds and final-channel recovery never call compressor; LARGE continuation does; compressor input excludes tool/tool_result text from the original conversation; compressor failure still reaches recovery via deterministic fallback.
- [ ] **Step 2: Run** the focused managed-loop tests and confirm RED.
- [ ] **Step 3: Implement integration** so preparation is invoked only after route selection, diagnostics/progress are emitted, and the original conversation/tools remain untouched.
- [ ] **Step 4: Re-run** focused tests and confirm PASS.

### Task 4: Progress transparency

**Files:**
- Modify: `src/proxy/progress.js`
- Test: `test/progress.test.js`
- Test: `test/managed-loop.test.js`

**Interfaces:**
- Adds localized status keys for continuation state organization and preserved-state handoff.

- [ ] **Step 1: Write failing tests** for zh-TW progress text containing produced/preserved size semantics without exposing raw state.
- [ ] **Step 2: Run** focused progress tests and confirm RED.
- [ ] **Step 3: Add localized progress strings** and wire them to preparation start/completion.
- [ ] **Step 4: Re-run** focused tests and confirm PASS.

### Task 5: Release contract and verification

**Files:**
- Modify: `src/version.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `V0.2.28.5-更新說明.md`
- Modify: `scripts/verify.sh`
- Modify current-version tests as required.

**Interfaces:**
- Current release reports `0.2.28.5`.
- Cache generations stay `media-v7 / visual-v10 / evidence-v6`.

- [ ] **Step 1: Add failing deployment/release assertions** for v0.2.28.5, recovery-only compressor scope, no new ENV, and unchanged cache generations.
- [ ] **Step 2: Run focused release tests and confirm RED.**
- [ ] **Step 3: Update release metadata/docs/verify contract** without altering historical release semantics.
- [ ] **Step 4: Run focused release tests and confirm PASS.**
- [ ] **Step 5: Run full verification:** `npm test`, `npm run check`, `scripts/verify.sh`.
- [ ] **Step 6: Build clean release staging, regenerate `MANIFEST.sha256`, rerun verification from staging, create ZIP and SHA256, verify ZIP integrity and zero `(1)` paths.**
