# Final Language Shift Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add original-vs-repaired language-shift validation so a repair that makes a substantial target-language conversion can be accepted even when the absolute classifier still reports the original source language.

**Architecture:** Keep the V0.2.28.12 technical-token-aware absolute classifier as the primary validator. Only when repaired output is still classified as `repair` in the same source language as the original, compute target-language gain and source-language reduction; accept only when both shifts are substantial. Wrong target variants/scripts remain hard failures.

**Tech Stack:** Node.js 22+, native node:test, existing Final Language Gate telemetry/event pipeline.

## Global Constraints

- Preserve V0.2.28.12 Technical Token stripping and `LANG_PROCESSOR_*` behavior.
- Do not accept zh-CN for zh-TW or zh-TW for zh-CN through shift rescue.
- Do not treat a few added target-language words as successful translation.
- Log the original/repaired target and source counts plus gain/reduction telemetry.
- Release version is `0.2.28.13`.

---

### Task 1: Language-shift regression tests

**Files:**
- Modify: `test/final-language-gate.test.js`

**Interfaces:**
- Consumes: `applyFinalLanguageGate()` and `classifyFinalLanguage()`.
- Produces: regression expectations for `accept_by_language_shift` and hard rejection of trivial/variant-mismatch repairs.

- [ ] Add a failing test where English remains absolute-detected as English after repair but Han grows substantially and natural Latin drops substantially; expect external repair accepted.
- [ ] Add a failing test where only a short Chinese preface is added; expect rejection and Base fallback.
- [ ] Add a failing test where English becomes Simplified Chinese for `zh-TW`; expect hard rejection rather than shift rescue.
- [ ] Run targeted tests and confirm RED.

### Task 2: Shift validator and telemetry

**Files:**
- Modify: `src/proxy/final-language-gate.js`

**Interfaces:**
- Consumes: original/repaired language classifications.
- Produces: shift decision with `target_gain`, `source_reduction`, ratios, and `accept_by_language_shift` outcome.

- [ ] Add target/source character-count helpers based on target locale and original detected source language.
- [ ] Require minimum target gain, minimum source reduction, and minimum source-reduction ratio.
- [ ] Permit rescue only when repaired absolute classification remains the same original source language; never rescue wrong language/variant transitions.
- [ ] Emit `final_language_repair_validation` with shift telemetry.
- [ ] Run targeted tests and confirm GREEN.

### Task 3: Release metadata and full verification

**Files:**
- Modify: `src/version.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `V0.2.28.13-更新說明.md`
- Modify: release assertions under `test/` and `scripts/verify.sh` as required.

**Interfaces:**
- Produces: verified `0.2.28.13` release bundle.

- [ ] Update version and release documentation.
- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `bash scripts/verify.sh`.
- [ ] Package ZIP and verify extracted `MANIFEST.sha256`.
