# V0.29.5 Visual Detail Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `CONTENT + NEEDS_ZOOM` actionable without conflating visible content with sufficient detail.

**Architecture:** Extend the existing evidence parser/classifier with a second `VISUAL_DETAIL` dimension. Keep `needsZoom` as the existing dispatcher interface so generic image and PDF zoom pipelines require no architectural replacement. Cache generations change because the prompt and accepted evidence contract change.

**Tech Stack:** Node.js 22+, ES modules, `node:test`, existing Vision/media adapter pipeline.

## Global Constraints

- Version: `0.29.5`.
- No new ENV variables.
- Existing overlapping generic zoom remains 15% overlap and maximum 6 tiles.
- Legacy `VISUAL_STATUS: NEEDS_ZOOM` remains accepted.
- Missing `VISUAL_DETAIL` for `CONTENT` must never imply `SUFFICIENT`.
- Do not include cache fast-path or context-history slimming changes.

---

### Task 1: Evidence contract parser and classification

**Files:**
- Modify: `src/visual/vision-client.js`
- Test: `test/vision-client.test.js`

**Interfaces:**
- Consumes: final Vision Markdown.
- Produces: `{ quality, cacheable, visualStatus, visualDetail, contractValid, reasons }` internally and `{ needsZoom, visualStatus, visualDetail }` externally.

- [ ] Add failing tests for `CONTENT + SUFFICIENT`, `CONTENT + NEEDS_ZOOM`, missing detail, and legacy `NEEDS_ZOOM`.
- [ ] Run focused Vision tests and verify the new cases fail on v0.29.4.
- [ ] Add `VISUAL_DETAIL` parsing and contract rules.
- [ ] Update output/recovery prompts and local repair so detail is never invented.
- [ ] Propagate `visual_detail` diagnostics and `visualDetail` result field.
- [ ] Run focused Vision tests to green.

### Task 2: Zoom dispatch regression coverage

**Files:**
- Test: `test/media-adapters.test.js`
- Modify only if required: `src/proxy/media-adapters.js`

**Interfaces:**
- Consumes: `result.needsZoom` from Vision analysis.
- Produces: existing `analyzeGenericZoomFallback()` execution.

- [ ] Add a failing regression test proving `CONTENT + VISUAL_DETAIL: NEEDS_ZOOM` reaches generic overlapping tiles.
- [ ] Run the focused media-adapter test and verify failure before production change if Task 1 alone does not satisfy it.
- [ ] Keep dispatcher changes minimal; reuse `needsZoom`.
- [ ] Run media-adapter tests to green.

### Task 3: Cache generations and compatibility fixtures

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`
- Update evidence-mode Vision fixtures across `test/*.test.js` where they intentionally represent valid `CONTENT` output.

**Interfaces:**
- Produces: `visualPromptVersion=visual-v15`, `evidenceContractVersion=evidence-v11`.

- [ ] Add/update tests for the new cache generations.
- [ ] Verify expected failure on old generation values.
- [ ] Bump visual/evidence generations.
- [ ] Update valid `CONTENT` fixtures to state `VISUAL_DETAIL: SUFFICIENT` explicitly.
- [ ] Run affected test groups.

### Task 4: Version, documentation, verification, package

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js`, `README.md`, `CHANGELOG.md`
- Create: `V0.29.5-更新說明.md`
- Regenerate: `MANIFEST.sha256`

**Interfaces:**
- Produces: deployable `vllm-cc-tools-proxy-v0.29.5.zip`.

- [ ] Update version metadata and documentation.
- [ ] Run `npm run check`.
- [ ] Run focused Vision/media/config tests.
- [ ] Run full `npm test`; distinguish the pre-existing managed-loop timing flake if it reappears.
- [ ] Regenerate SHA256 manifest and verify archive contents.
- [ ] Package clean ZIP without duplicate-download suffix.
