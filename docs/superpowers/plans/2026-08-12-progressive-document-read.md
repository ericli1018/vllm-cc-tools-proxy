# Progressive Document Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V0.29.0 progressive PDF Document Map and persistent original-source cache while preserving native `Read.pages` detailed evidence.

**Architecture:** `parsePdf()` branches to a bounded local map for unscoped PDFs above 20 pages. `DocumentSourceCache` persists original PDF blobs keyed by content SHA and maps opaque Read source refs to those blobs. Media adapters and Proxy cache preflight use a dedicated progressive PDF namespace and `kind=document_map` evidence.

**Tech Stack:** Node.js 22, Poppler, existing MediaCache/Claude Code Read pipeline.

## Global Constraints

- No new ENV variables.
- Keep V0.2.28.20 large-media safety and V0.2.28.19 progress/status telemetry unchanged.
- Keep native Claude Code `Read.pages` as the only user/model-facing detailed-page selector.
- Raw PDF/Base64 must never reach Base vLLM.

---

### Task 1: Document Map parser
- [x] RED tests for large text/scanned PDFs.
- [x] Branch unscoped PDFs above 20 pages before whole-document page limits/Vision.
- [x] Bound map sampling to 24 pages and mark result `document_mode=map`.

### Task 2: Persistent source cache
- [x] RED tests for persist/resolve/update.
- [x] Store original blobs by SHA256 and map opaque Read source refs without path filenames.
- [x] Prefer cached original source for later focused `Read.pages`.

### Task 3: Cache/evidence integration
- [x] Add progressive unscoped PDF cache namespace.
- [x] Add `kind=document_map` Evidence Contract and `Read.pages` continuation rule.
- [x] Bump media/evidence generations without new ENV.

### Task 4: End-to-end verification
- [x] Proxy regression verifies original-source reuse and no raw Base64 upstream leakage.
- [ ] Run full tests, syntax, verify, package, manifest and extracted verification.
