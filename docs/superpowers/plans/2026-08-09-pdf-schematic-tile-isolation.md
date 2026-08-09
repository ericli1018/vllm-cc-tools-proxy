# PDF Schematic Tile Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release V0.2.28.4 so schematic PDF tiles are isolated into one Vision request each, individual tile service failures do not abort the whole PDF, transport failures retain safe root-cause diagnostics, and SCHEMATIC routing is stricter.

**Architecture:** Keep existing PDF semantic routes and overview/tiling geometry. Replace schematic tile batching with sequential per-tile Vision calls and catch only expected upstream `HttpError` failures at the tile boundary, recording a bounded missing-evidence marker plus warning. Preserve programming errors. Extend shared fetch error normalization with safe transport cause metadata and propagate it through Vision diagnostics. Tighten only the classifier prompt; do not add another model call or heuristic parser.

**Tech Stack:** Node.js ES modules, node:test, Ollama/vLLM Vision clients, Poppler rendering, existing Media Cache.

## Global Constraints

- Version: `0.2.28.4`.
- No new ENV variables.
- Schematic tiles: exactly one tile per Vision request, sequential.
- Ordinary DIAGRAM/DENSE_PAGE batching remains unchanged.
- Individual schematic tile upstream/model `HttpError` must not abort the PDF; unexpected programming errors must still propagate.
- Vision Quality Gate and Adaptive Thinking Recovery from V0.2.28.3 remain unchanged.
- No Ollama streaming in this release.
- Cache generations advance because PDF visual evidence semantics/classification change; media identity generation remains unchanged.

---

### Task 1: Isolate schematic tile Vision calls

**Files:**
- Modify: `src/parsers/pdf.js`
- Test: `test/pdf-parser.test.js`

**Interfaces:**
- Consumes: existing `tileEntries[]` and `analyzeVisualAssets([asset], options)`.
- Produces: one `pdf_schematic_tile_analyze` progress event per tile and one region-evidence entry per successful tile; failed expected upstream tiles produce a bounded evidence-gap entry and warning.

- [ ] Write a failing test that renders at least four schematic tiles and asserts every tile Vision call receives one asset.
- [ ] Write a failing test where one tile throws `HttpError(502, ..., {code:'vision_service_error'})` and later tiles still run; result must contain successful neighboring evidence and a missing-tile marker.
- [ ] Write a failing test proving a plain `Error` from tile analysis still propagates.
- [ ] Replace schematic `batchVisualPages()` use with a sequential per-tile loop and bounded expected-error containment.
- [ ] Run focused PDF parser tests.

### Task 2: Preserve transport root-cause diagnostics

**Files:**
- Modify: `src/lib/media.js`
- Modify: `src/visual/vision-client.js`
- Test: `test/media.test.js` or existing shared media test file
- Test: `test/vision-client.test.js`

**Interfaces:**
- Consumes: native fetch errors and nested `cause.code` values.
- Produces: `HttpError.details.transport_code`, safe phase inference, and Vision response diagnostic fields without leaking URLs, bodies, or image bytes.

- [ ] Add a failing fetch error normalization test for nested `cause.code='UND_ERR_HEADERS_TIMEOUT'`.
- [ ] Add a failing Vision diagnostic test asserting safe `transport_code`/`transport_phase` is emitted on a transport exception.
- [ ] Preserve existing public `vision_service_error` code while attaching root-cause details and a more accurate bounded message for timeout cases.
- [ ] Run focused media/Vision tests.

### Task 3: Tighten SCHEMATIC classification contract

**Files:**
- Modify: `src/visual/pdf-page-classifier.js`
- Test: `test/pdf-page-classifier.test.js`

**Interfaces:**
- Consumes: existing one-page classification image.
- Produces: same three-line classifier response contract and same four route names.

- [ ] Add a failing prompt-contract test requiring positive electronic-circuit evidence for SCHEMATIC and explicit exclusion of flowcharts/screenshots/architecture diagrams.
- [ ] Update classifier prompt only; do not add heuristic route rewriting.
- [ ] Run focused classifier tests.

### Task 4: Release/cache contract and documentation

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js`
- Modify: cache generation constants at their current locations
- Modify: `README.md`, `CHANGELOG.md`, `scripts/verify.sh`
- Create: `V0.2.28.4-更新說明.md`
- Test: version/deployment/cache tests

**Interfaces:**
- Produces: `0.2.28.4`, `media-v7`, `visual-v10`, `evidence-v6`.

- [ ] Add failing release-contract assertions.
- [ ] Update version/cache generations and docs.
- [ ] Run focused deployment/version tests.
- [ ] Run full `npm test`, `npm run check`, and `bash scripts/verify.sh`.
- [ ] Package staged release, rebuild `MANIFEST.sha256`, verify ZIP integrity and SHA256, and ensure no `(1)` archive paths.
