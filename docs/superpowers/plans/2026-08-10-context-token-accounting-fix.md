# Context Token Accounting Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release VLLM-CC-TOOL-PROXY v0.2.28.8 with correct Anthropic input-token accounting when preflight total usage is followed by vLLM prefix-cache split usage.

**Architecture:** Keep `/v1/messages/count_tokens` as an early provisional total. Change `ProgressStream` input-side usage from four independent monotonic counters to an atomic input tuple: whenever an observed event contains any input-side usage field, replace the entire input tuple with that observed representation; when an observed event contains only `output_tokens`, preserve the current input tuple and update output only. Do not add Context Compact model routing in this release.

**Tech Stack:** Node.js 22+, ES modules, node:test.

## Global Constraints

- Base release: `0.2.28.7`.
- Target release: `0.2.28.8`.
- No new ENV.
- No Qwen Context Compact routing yet.
- No changes to Managed Continuation, WebFetch Processor, Final Language Repair, PDF/Vision, reasoning, or token budget.
- Preserve fail-safe behavior when upstream usage is partial.

---

### Task 1: Add regression coverage for cache-aware usage replacement

**Files:**
- Modify: `test/progress.test.js`

**Interfaces:**
- Consumes: `ProgressStream.usageForDelta(observed)`.
- Produces: regression assertions for cache-split input usage and output-only deltas.

- [ ] **Step 1:** Add a test where initial preflight is `input_tokens=197500` and observed upstream usage is `input_tokens=5000, cache_read_input_tokens=192500`; expect total input to remain `197500`, not `390000`.
- [ ] **Step 2:** Add a test proving an output-only delta preserves the last authoritative input tuple.
- [ ] **Step 3:** Run `node --test test/progress.test.js` and verify the cache-split test fails against v0.2.28.7.

### Task 2: Implement atomic input-side usage merge

**Files:**
- Modify: `src/proxy/progress.js`

**Interfaces:**
- Consumes: raw observed Anthropic usage object.
- Produces: normalized Claude-facing usage object.

- [ ] **Step 1:** Detect presence of any raw input-side field before normalization.
- [ ] **Step 2:** If any input-side field is present, replace `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` as one tuple, defaulting omitted members to zero.
- [ ] **Step 3:** If no input-side field is present, preserve the current tuple.
- [ ] **Step 4:** Continue to use observed `output_tokens` when present and preserve current output otherwise.
- [ ] **Step 5:** Run `node --test test/progress.test.js` and verify all tests pass.

### Task 3: Version, documentation, and full verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.js`
- Modify: `CHANGELOG.md`
- Create: `V0.2.28.8-更新說明.md`
- Regenerate: `MANIFEST.sha256`

**Interfaces:**
- Produces: clean v0.2.28.8 release bundle.

- [ ] **Step 1:** Bump version to `0.2.28.8`.
- [ ] **Step 2:** Document the atomic usage merge fix and the reproduced `197500 -> 390000` failure mode.
- [ ] **Step 3:** Run `npm test`.
- [ ] **Step 4:** Run `npm run check`.
- [ ] **Step 5:** Run `scripts/verify.sh` if executable or via `bash scripts/verify.sh`.
- [ ] **Step 6:** Regenerate `MANIFEST.sha256` after all files are finalized.
- [ ] **Step 7:** Package as `vllm-cc-tools-proxy-v0.2.28.8.zip` with no duplicate-download suffix.
