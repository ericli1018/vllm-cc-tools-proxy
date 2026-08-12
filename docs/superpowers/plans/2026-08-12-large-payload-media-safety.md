# Large Payload & Media Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make v0.2.28.20 safely accept large supported Base64 PDF/image payloads without RegExp or recursive call-stack overflow, while bounding resource amplification.

**Architecture:** Keep request/media semantics unchanged, but move Base64 size rejection before content validation and replace the whole-string quantified RegExp with an O(n), O(1)-stack validator. Skip raw Base64 in protocol/diagnostic scans, bound recursive request walkers, avoid unnecessary history cloning, and reject normalized-image output that exceeds the configured byte profile.

**Tech Stack:** Node.js 22 ESM, built-in node:test, existing HttpError/media pipeline.

## Global Constraints

- Release version: 0.2.28.20.
- No new required ENV variables.
- Preserve PDF/PNG/JPEG/GIF/WebP media support and MIME magic verification.
- Preserve 30-second SSE progress, native statusLine, Language Repair, Managed Loop, WebSearch/WebFetch behavior.
- Large-payload failures must be bounded HttpError responses, never RangeError stack overflows.

---

### Task 1: Stack-safe Base64 media validation
**Files:** `src/lib/media.js`, `test/media-adapters.test.js`
- [ ] Add failing large PDF/PNG and oversize-order tests.
- [ ] Replace whole-string Base64 RegExp with size-first iterative validation.
- [ ] Run targeted tests.

### Task 2: Large-payload protocol and diagnostic hardening
**Files:** `src/proxy/protocol-sanitizer.js`, `src/proxy/web-tool-diagnostic-trace-store.js`, `src/services/proxy-server.js`, related tests.
- [ ] Add failing tests proving raw Base64 is skipped/omitted.
- [ ] Make protocol traversal Base64-aware and bounded.
- [ ] Avoid WebFetch history structuredClone when no returned WebFetch fallback needs enrichment.
- [ ] Run targeted tests.

### Task 3: Bounded media traversal and normalized output guard
**Files:** `src/proxy/media-preflight.js`, `src/proxy/content-blocks.js`, `src/proxy/image-payload-observer.js`, `src/proxy/media-progress.js`, `src/parsers/image.js`, related tests.
- [ ] Add deep/cycle and normalized-output failing tests.
- [ ] Add fixed-depth/cycle guards with controlled 422 errors.
- [ ] Enforce maxDecodedBytes after image normalization.
- [ ] Run targeted tests.

### Task 4: Diagnostics and release verification
**Files:** `src/services/proxy-server.js`, version/docs/verify metadata.
- [ ] Add request stage/error name/stack logging without payload leakage.
- [ ] Update version metadata, README, CHANGELOG, release note, verify contract.
- [ ] Run full tests, syntax, verify, package, extract, manifest and ZIP integrity verification.
