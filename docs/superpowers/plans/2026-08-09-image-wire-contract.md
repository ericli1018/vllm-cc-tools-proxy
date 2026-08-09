# IMAGE Wire Contract & Source-Aware Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code image payload handling observable and provenance-aware without changing the existing Vision behavior or exposing raw image/path data.

**Architecture:** Keep the existing recursive media adapter as the execution path. Add a focused image payload observer that derives origin/provenance from message/tool history, preserves only an allowlisted safe metadata subset through preflight, emits one structural diagnostic per image occurrence, and exposes origin/received-dimension metadata in cached image metadata while keeping the evidence contract stable.

**Tech Stack:** Node.js 22+, ESM, node:test, existing media/Vision pipeline.

## Global Constraints

- Base version: 0.2.27.3; release version: 0.2.28.
- No new ENV variables.
- Do not log raw Base64, raw image bytes, or full local paths.
- Do not rewrite Image Vision, recursive crop, Media Cache, PDF routing, or Managed Loop behavior.
- Keep cache generations `media-v7`, `visual-v6`, `evidence-v2` unless image analysis semantics change; this release does not change them.
- Support image origins `read`, `direct`, and `tool_result` without inventing MCP-specific wire fields.
- Package artifact name must be exactly `vllm-cc-tools-proxy-v0.2.28.zip`; no `(1)` suffix/path.

---

### Task 1: Image provenance descriptor

**Files:**
- Create: `src/proxy/image-payload-observer.js`
- Test: `test/image-payload-observer.test.js`

**Interfaces:**
- Consumes: original request `messages` before Base64 is replaced.
- Produces: `observeImagePayloads(messages)` returning structural descriptors keyed by content path.

- [ ] Write failing tests for nested `Read` image, direct image, generic tool-result image, safe metadata keys, and path redaction.
- [ ] Run `node --test test/image-payload-observer.test.js` and confirm RED.
- [ ] Implement `observeImagePayloads(messages)` with Read tool-use correlation and structural-only metadata.
- [ ] Re-run focused test and confirm GREEN.

### Task 2: Safe metadata preservation through media preflight

**Files:**
- Modify: `src/proxy/media-preflight.js`
- Test: `test/media-preflight.test.js`

**Interfaces:**
- Consumes: safe image metadata already present on block/source.
- Produces: request-scoped `proxy_file` image source retaining only safe non-payload metadata.

- [ ] Add failing tests proving safe dimension/original-dimension metadata is retained while unknown path-like/raw fields are dropped.
- [ ] Verify RED.
- [ ] Implement allowlisted metadata copy without altering cache fingerprint semantics.
- [ ] Verify GREEN.

### Task 3: Runtime diagnostic integration

**Files:**
- Modify: `src/services/proxy-server.js`
- Modify: `src/proxy/media-progress.js`
- Test: `test/proxy-server.test.js`
- Test: `test/media-progress.test.js`

**Interfaces:**
- Consumes: structural descriptors from Task 1 and prepared media occurrence paths.
- Produces: `image_payload_observed` log events with origin, parent/source type, media type, decoded bytes, received dimensions, safe key inventories, and Read basename/hash only.

- [ ] Add failing integration test that sends a standard nested `Read(image)` payload and captures logger diagnostics.
- [ ] Verify RED.
- [ ] Wire observer before preflight mutation and emit diagnostics after decoded media entries are available.
- [ ] Ensure no raw Base64/full path appears in diagnostics.
- [ ] Verify GREEN.

### Task 4: Image metadata/cache observability

**Files:**
- Modify: `src/proxy/media-adapters.js`
- Test: `test/media-adapters.test.js`

**Interfaces:**
- Consumes: safe source metadata and normalized image dimensions.
- Produces: cache metadata containing received dimensions and safe origin metadata; evidence body remains unchanged.

- [ ] Add failing tests for cache metadata fields and existing evidence compatibility.
- [ ] Verify RED.
- [ ] Implement minimal metadata additions.
- [ ] Verify GREEN.

### Task 5: Release metadata and verification

**Files:**
- Modify: `package.json`
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `V0.2.28-更新說明.md`
- Modify: `scripts/verify.sh`
- Regenerate: `MANIFEST.sha256`
- Test: `test/version.test.js` plus full suite.

**Interfaces:**
- Produces: verified V0.2.28 release package.

- [ ] Update version assertions/docs and add V0.2.28 release contract to `verify.sh`.
- [ ] Run full `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `bash scripts/verify.sh` and require exit 0.
- [ ] Regenerate `MANIFEST.sha256` and verify entries.
- [ ] Package exactly `vllm-cc-tools-proxy-v0.2.28.zip`.
- [ ] Run `unzip -t`, compute SHA256, and verify no archive path contains `(1)`.
