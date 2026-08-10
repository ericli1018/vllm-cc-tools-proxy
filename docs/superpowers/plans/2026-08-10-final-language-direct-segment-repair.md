# Final Language Direct-Segment Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-maintained language-repair segment markers with Proxy-owned per-segment direct translation and deterministic block reassembly.

**Architecture:** `applyFinalLanguageGate` continues to own final-response classification and text-block indices. `final-language-repair.js` changes from batched marker encoding/parsing to direct single-segment translation primitives, while wrapper functions iterate segments sequentially and return an array in source order. External and Base paths remain tool-less and isolated from the original Claude Code conversation.

**Tech Stack:** Node.js ESM, built-in `node:test`, OpenAI-compatible external processor, Anthropic-compatible Base adapter.

## Global Constraints

- Release version is `0.2.28.6`.
- No new ENV variables.
- No marker protocol is sent to either language repair backend.
- Proxy, not the model, owns segment ordering and text-block mapping.
- No tools are available to language repair backends.
- Existing target-language post-validation remains authoritative.
- All repair failures preserve the original successful response after fallbacks are exhausted.
- Cache generations remain `media-v7 / visual-v10 / evidence-v6`.

---

### Task 1: Direct external segment translation

**Files:**
- Modify: `test/final-language-repair.test.js`
- Modify: `src/services/final-language-repair.js`

**Interfaces:**
- Consumes: `segments: string[]`, locale, external processor config.
- Produces: `rewriteFinalSegmentsWithExternalProcessor(...): Promise<string[]>` with one request per segment.

- [ ] Add RED tests proving a single segment request contains no VCC marker and returns plain translated text.
- [ ] Add RED tests proving two segments produce two backend requests in source order and deterministic array output.
- [ ] Add RED tests proving tool-call or empty output fails the current segment.
- [ ] Implement the minimal direct-segment external request path.
- [ ] Run focused tests to GREEN.

### Task 2: Direct Base segment translation

**Files:**
- Modify: `test/final-language-repair.test.js`
- Modify: `src/services/final-language-repair.js`
- Modify only if required: `src/services/proxy-server.js`

**Interfaces:**
- Produces isolated Base requests with one source segment and plain translated visible text extraction.

- [ ] Add RED tests proving Base requests contain no marker protocol and no tools.
- [ ] Add RED tests proving Base visible text is accepted directly and tool-use/empty output is rejected.
- [ ] Implement minimal Base direct-segment request/extraction while preserving existing isolation/thinking flags.
- [ ] Run focused tests to GREEN.

### Task 3: Gate integration and diagnostics

**Files:**
- Modify: `test/final-language-gate.test.js`
- Modify: `test/proxy-server.test.js` if wiring assertions require it.
- Modify: `src/services/final-language-repair.js`
- Modify: `src/proxy/final-language-gate.js` only if per-segment validation/wiring requires it.

**Interfaces:**
- Existing `applyFinalLanguageGate()` contract remains unchanged.

- [ ] Add regression coverage for the observed single-segment `invalid_segments` failure mode.
- [ ] Add multi-block deterministic reassembly coverage.
- [ ] Add safe per-segment processor diagnostic assertions.
- [ ] Implement only the wiring needed for those tests.
- [ ] Run focused language/proxy tests to GREEN.

### Task 4: Release contract and verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js`
- Modify: `README.md`, `CHANGELOG.md`, `scripts/verify.sh`
- Create: `V0.2.28.6-更新說明.md`

- [ ] Add RED release assertions for version/docs/direct-segment contract.
- [ ] Update release metadata/docs without changing cache versions or ENV surface.
- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `scripts/verify.sh`.
- [ ] Build release staging with `scripts/package.sh`.
- [ ] Verify staging MANIFEST, ZIP integrity, root layout, no `(1)` paths, and ZIP SHA256.
