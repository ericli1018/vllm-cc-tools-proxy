# Final Language Strict Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make final-language repair reliably translate natural-language prose while preserving technical tokens, detect unchanged echoes, retry each backend once with a strict contract, and fix semantic-byte logging at managed round completion.

**Architecture:** Keep the existing absolute classifier and language-shift validator unchanged. Strengthen the shared repair prompt, expose strict-retry mode to External and Base repair functions, detect unchanged normalized output in the gate, and retry the same backend once before falling through. Preserve all existing fallback order and anti-loop bounds. Capture round semantic bytes before clearing round state.

**Tech Stack:** Node.js ESM, Anthropic Messages-compatible proxy, Ollama/OpenAI-compatible language processor, node:test.

## Global Constraints

- Release version: `0.2.28.18`.
- External backend maximum attempts per repair: 2 (normal + one strict retry).
- Base backend maximum attempts per repair: 2 (normal + one strict retry).
- Do not relax final-language validation thresholds.
- Do not add new ENV variables.
- Preserve `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP` support.
- Preserve v0.2.28.17 semantic model-output telemetry behavior.

---

### Task 1: Strict translation contract and echo detection

**Files:**
- Modify: `src/services/final-language-repair.js`
- Modify: `src/proxy/final-language-gate.js`
- Test: `test/final-language-repair.test.js`
- Test: `test/final-language-gate.test.js`

**Interfaces:**
- `rewriteFinalSegmentsWithExternalProcessor(segments, options)` accepts `strict?: boolean`.
- `buildBaseLanguageRepairRequest(segment, options)` accepts `strict?: boolean`.
- Gate invokes rewrite functions as `rewrite(segments, locale, { strict, attempt })`.

- [ ] Write failing tests for mandatory translation wording, delimiter isolation, unchanged-output detection, one strict retry, and retry bound.
- [ ] Run targeted tests and confirm RED failures are feature-related.
- [ ] Implement strict prompt contract and normalized unchanged-output detection.
- [ ] Implement one strict retry per backend before fallback.
- [ ] Run targeted tests and confirm GREEN.

### Task 2: Managed round semantic-byte completion snapshot

**Files:**
- Modify: `src/services/proxy-server.js`
- Test: `test/proxy-server.test.js`

**Interfaces:**
- `managed_model_round_completed.model_output_bytes` must represent the completed round's semantic model-output bytes even after round state becomes inactive.

- [ ] Write a failing integration assertion reproducing nonzero semantic output with zero completion log.
- [ ] Run targeted test and confirm RED.
- [ ] Snapshot semantic round bytes before deactivating/resetting round state.
- [ ] Run targeted test and confirm GREEN.

### Task 3: Release metadata and full verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js`, `README.md`, `CHANGELOG.md`, `scripts/verify.sh`
- Create: `V0.2.28.18-更新說明.md`

- [ ] Update release metadata to `0.2.28.18` and document strict retry/echo detection.
- [ ] Run full tests, JavaScript syntax checks, and `scripts/verify.sh`.
- [ ] Package the release, verify manifest and ZIP integrity, and publish a clean filename.
