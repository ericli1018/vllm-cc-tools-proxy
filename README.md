# VLLM-CC-TOOLS-PROXY

`VLLM-CC-TOOLS-PROXY` is a transparent Claude Code gateway for local vLLM. V0.29.8 makes visual crop exhaustion terminal and recoverable instead of request-fatal, while V0.29.7 adds failure-aware Vision recovery with one original request plus up to three progressively simpler retries, while V0.29.6 makes generic zoom terminal and cache-safe while V0.29.5 separates visible-content detection from visual-detail sufficiency, so dense images can be recognized as real content while still triggering the existing precise-crop or overlapping-tile zoom path. It retains V0.29.4 generic zoom/provenance repair, V0.29.3 recursive PDF zoom, V0.29.2 machine-checkable Vision status, V0.29.1 recovery safety, and V0.29.0 progressive PDF reading.






## V0.29.8 Visual Crop Terminal Recovery

V0.29.8 keeps the VisualAssetRegistry maximum crop depth at 2 but changes crop exhaustion from a request-fatal condition into a bounded Vision recovery condition. `visual_crop_depth_limit` is returned as a controlled non-retryable crop-tool result; the Vision worker disables crop tools for that visual attempt and continues with the existing `focused_recovery` → `structured_extraction` → `last_chance_salvage` policy instead of aborting `/v1/messages`.

Any call using `recoveryContext=zoom_tile` may perform at most one precise crop round. After that first precise crop round, subsequent Vision requests no longer expose `request_image_crop`. If the model nevertheless emits a stale/undeclared crop call, it is treated as unusable output and recovered from the already available images/crops; the crop processor is not invoked a second time. This applies centrally to generic IMAGE zoom tiles and to PDF `DIAGRAM`/`DENSE_PAGE` and `SCHEMATIC` tiles.

Recovery prompts are crop-budget aware. When a precise crop is still available, an already enlarged tile may request one accurately identified smaller region. Once the budget is exhausted, the overlay explicitly states that no further crop is allowed and asks for reliable partial evidence plus uncertainty from the current images. `PARTIAL` and failed evidence remain non-cacheable.

Safe diagnostics include `vision_crop_budget_exhausted` with the exhaustion reason, crop round/count, and recovery context. The media pipeline remains `media-v8`; cache generations advance to `visual-v18` and `evidence-v14`. No new ENV variable is added.

## V0.29.7 Failure-Aware Vision Recovery

V0.29.7 adds a shared recovery policy for IMAGE analysis and PDF visual workers. A failed visual request gets the original attempt plus at most 3 retries. Recovery stops immediately on success and uses a different prompt strategy on each retry: `focused_recovery`, `structured_extraction`, then `last_chance_salvage`. The original visual task remains in context; the recovery text is an overlay that changes recovery strategy rather than assuming the media is a circuit diagram.

The recovery prompts are content-agnostic. They can salvage visible evidence from ordinary documents, tables/forms, charts/plots, diagrams/flowcharts, technical drawings/schematics, UI/screenshots, photos/scenes/objects, and mixed/unknown images. A timeout recovery explicitly prioritizes speed and short factual extraction. An already enlarged zoom tile is told not to request another generic zoom; it should preserve readable partial evidence and uncertainty, using `request_image_crop` only when one precise smaller region can be identified.

The CONTENT evidence contract now asks the Vision worker to emit `VISUAL_COMPLETENESS: COMPLETE | PARTIAL` after `VISUAL_DETAIL`. The parser remains backward-compatible with older valid CONTENT evidence that omits completeness. Explicit `PARTIAL` evidence is usable but non-cacheable. Generic zoom summaries count partial tiles separately, and any partial/unresolved/failed tile keeps the composite non-cacheable.

PDF `DIAGRAM`/`DENSE_PAGE` zoom tiles and `SCHEMATIC` tiles use the same `zoom_tile` recovery context and a bounded 30-second child timeout. Whole-page/overview analysis retains the configured root Vision timeout. Retries reuse the same rendered tile bytes; they do not re-render or create another generic tiling layer.

Safe diagnostics include `vision_retry_started` with retry reason and `prompt_strategy`, `vision_retry_exhausted` after four total failed requests, and `visual_completeness` on Vision output diagnostics. No prompt body or image bytes are logged. Cache generations advance to `visual-v17` and `evidence-v13`; the media pipeline remains `media-v8`. No new ENV variable is added.

## V0.29.6 Generic Zoom Terminal Convergence

V0.29.6 keeps the V0.29.5 `VISUAL_STATUS + VISUAL_DETAIL` detection contract unchanged, but makes generic-image zoom a bounded terminal recovery layer. The deterministic generic fallback still uses the existing 15% overlap and at most 6 automatic tiles; each zoom tile now runs with `allowNeedsZoomFallback=false`. A tile may use one precise `request_image_crop` when a smaller region can resolve the missing detail, but it must otherwise finish as readable evidence or `UNREADABLE` instead of returning another actionable whole-tile `NEEDS_ZOOM` state.

Every generic zoom pass now produces a resolution summary:

```text
terminal_status: resolved | partial | unreadable
resolved: N/T; unresolved: N; failed: N
```

`resolved` means every deterministic tile completed terminal evidence. `partial` means at least one tile resolved but one or more tiles remained unresolved or failed. `unreadable` means no tile resolved. The Proxy also emits the safe `vision_zoom_summary` diagnostic with `tile_count`, `resolved_count`, `unresolved_count`, `failed_count`, `terminal_status`, and `cacheable`.

Composite Media Cache writes now respect producer cacheability. Any generic zoom result with unresolved or failed tiles is returned to the current request as partial evidence but is **not** persisted; the cache lifecycle emits `media_cache_skip` with reason `non_cacheable_terminal_evidence`. Only fully resolved terminal composite evidence may be cached. This prevents a later Claude Code turn from reusing an incomplete zoom result containing timeout gaps or unresolved tiles.

Generic zoom tile calls also use an internal **30-second** upper bound: `min(VLLM_VISION_TIMEOUT_MS, 30000)`. The root Vision request keeps the configured Vision timeout. This avoids the 120-second pathological stall observed in v0.29.5 from multiplying across several best-effort zoom tiles, while adding no new ENV variable.

Literal visual control-protocol markup is no longer accepted as evidence. After native/inline `<think>` removal, remaining tags such as `<tool_call>`, `<function_result>`, `<arg_key>`, and `<arg_value>` produce `quality=weak`, reason `control_tag_leak`, and `cacheable=false`. The Vision worker receives one existing strict recovery attempt; persistent leakage ends as `vision_output_invalid` and, for a generic tile, becomes a failed terminal tile rather than entering Base-model evidence.

Because terminal zoom semantics and cache eligibility changed, cache generations advance to `visual-v16` and `evidence-v12`; the media pipeline remains `media-v8`. No new required ENV variable is added.

## V0.29.5 Visual Detail Contract

V0.29.5 splits the evidence-producing Vision result into two independent questions: whether real visual content exists, and whether the current scale is sufficient to read the required details reliably. A `CONTENT` result is no longer automatically treated as detail-complete.

The canonical `CONTENT` contract is now:

```text
VISUAL_STATUS: CONTENT
VISUAL_DETAIL: SUFFICIENT | NEEDS_ZOOM
VISUAL_EVIDENCE:
- concrete visible evidence
```

`VISUAL_DETAIL: SUFFICIENT` means the current image scale is adequate for reliable evidence extraction. `CONTENT + SUFFICIENT` is classified as **GOOD**, is cacheable, and completes the current visual pass.

`VISUAL_DETAIL: NEEDS_ZOOM` means real content is visible, but one or more required labels, values, pins, nets, table cells, arrows, or spatial relationships are too small or dense to read reliably. It is actionable and non-cacheable. The existing zoom dispatcher is reused unchanged: a precise `request_image_crop` remains preferred when the model can identify the region; otherwise ordinary images use the V0.29.4 deterministic generic fallback with **15% overlap** and at most 6 automatic tiles, while PDF `DIAGRAM` / `DENSE_PAGE` pages retain their V0.29.3 overlapping PDF-tile path.

A `CONTENT` response with missing `VISUAL_DETAIL` is **contract-invalid** and receives the existing bounded recovery. The Proxy must not infer `SUFFICIENT` from `CONTENT`, evidence length, or the presence of a `VISUAL_EVIDENCE` block. Local V0.29.4 formatting repair remains allowed only when a valid `VISUAL_DETAIL` already exists; the repair path never invents the detail state.

Legacy `VISUAL_STATUS: NEEDS_ZOOM` remains accepted for backward compatibility and is normalized internally to an actionable zoom-needed result. `BLANK` remains a successful cacheable empty-image state, and `UNREADABLE` remains non-usable evidence that must not be guessed from.

Vision diagnostics now include `visual_detail` alongside `visual_status`, `output_contract`, and `contract_valid`. Because both the prompt semantics and accepted evidence contract changed, cache generations advance to `visual-v15` and `evidence-v11`; the media pipeline remains `media-v8`. No new required ENV variable is added.

## V0.29.4 Generic Zoom Fallback & Vision Contract Repair

V0.29.4 makes `VISUAL_STATUS: NEEDS_ZOOM` actionable for ordinary image blocks as well as PDF visual pages. Generic images first receive one whole-frame Vision pass. If that pass returns `NEEDS_ZOOM` without a successful `request_image_crop`, the Proxy deterministically creates aspect-aware overlapping zoom tiles instead of resending the same whole frame. Generic tiles use 15% overlap, a maximum of 6 automatic tiles, and the existing VisualAssetRegistry depth limit of 2; a tile may still request one precise `request_image_crop` at the next depth. Each subsequent Vision call therefore receives new visual information rather than the unchanged root frame.

Image provenance now flows from Claude Code media context into safe diagnostics and normalized evidence. Supported fields include `origin` (`direct`, `read`, or `tool_result`), `origin_tool`, `source_kind`, hashed `read_source_ref`, and requested page numbers when available. Raw local paths are not placed in evidence. Read-produced images from a `.pdf` source are identified as `read_pdf_image`, which makes PDF-derived image behavior observable even when Claude Code supplies the page as an image block rather than an `application/pdf` block.

The Vision output contract now distinguishes semantic failure from formatting-only failure. A `VISUAL_STATUS: CONTENT` response that contains one or more non-protocol visible-content lines but only omits the `VISUAL_EVIDENCE:` marker is canonicalized locally into evidence bullets, emits `vision_contract_repaired`, and is not sent back through Vision a second time. Empty content, missing/invalid `VISUAL_STATUS`, `UNREADABLE`, or CONTENT with no body remain bounded recovery/error paths. No semantic facts are invented during repair.

Generic zoom progress phases (`image_zoom_tile`, `image_zoom_tile_render`, `image_zoom_tile_analyze`, `image_zoom_tile_failed`) are localized for zh-TW, zh-CN, en-US, ja-JP, and ko-KP. Vision/evidence cache generations advance to `visual-v14` / `evidence-v10`; the media pipeline remains `media-v8`. No new required ENV variable is added.

## V0.29.3 Recursive Vision Zoom & Overlapping Tiles

V0.29.3 extends the evidence-producing Vision contract with a fourth actionable state:

```text
VISUAL_STATUS: CONTENT
VISUAL_STATUS: BLANK
VISUAL_STATUS: NEEDS_ZOOM
VISUAL_STATUS: UNREADABLE
```

`NEEDS_ZOOM` means that real visual content is present but the whole-frame scale is too dense for reliable detail. It is **not** classified as WEAK or as a successful cacheable final result. When the visual model can identify a precise region, the existing `request_image_crop` tool remains the preferred path. Tool-requested normalized `[0,1000]` ROI coordinates receive a **12% outer context margin** before rendering so labels, nets, arrows, table rows, and relationships that cross the requested boundary are less likely to be cut off. Crop depth is bounded to a maximum zoom depth of **2**.

For PDF `DIAGRAM` and `DENSE_PAGE` evidence, if the model declares `NEEDS_ZOOM` without issuing a usable crop tool call, the PDF parser deterministically falls back to overlapping region coverage from the original PDF page. These fallback tiles use **15% overlap**, are analyzed sequentially, preserve `source_id`/bbox provenance, and are merged with the whole-page overview. A failed retryable tile preserves an explicit evidence gap and later tiles continue.

Electronic `SCHEMATIC` pages continue to use the existing whole-page overview plus deterministic tile workflow, but the schematic overlap is raised to **20%**. The extra shared region provides spatial continuity anchors for reference designators, net labels, wires, buses, and connectors that cross tile boundaries. Both fallback and schematic tilers remain bounded to at most 12 automatic tiles per page.

The recursive behavior is deliberately bounded:

```text
whole page
  -> CONTENT / BLANK: done
  -> precise region available: request_image_crop (+12% context margin)
  -> NEEDS_ZOOM without precise ROI: overlapping PDF tiles
       -> tile can request one more precise crop
       -> maximum zoom depth: 2
  -> UNREADABLE: bounded recovery / unavailable evidence
```

New progress phases include `vision_needs_zoom`, `pdf_zoom_tile`, `pdf_zoom_tile_render`, `pdf_zoom_tile_analyze`, and `pdf_zoom_tile_failed`; they are localized for zh-TW, zh-CN, en-US, ja-JP, and ko-KP. Because both the Vision prompt semantics and page-evidence contract changed, cache generations advance to `visual-v13` and `evidence-v9`. No new required ENV variable is added.

## V0.29.2 Vision Output Contract

V0.29.2 removes output length as the primary Vision quality signal. Final evidence-producing Vision responses now use a machine-checkable first-line contract:

```text
VISUAL_STATUS: CONTENT
VISUAL_STATUS: BLANK
VISUAL_STATUS: UNREADABLE
```

For `CONTENT`, the model must also emit the exact marker `VISUAL_EVIDENCE:` followed by one or more Markdown evidence bullets beginning with `- `. The Proxy validates this structure rather than trying to infer answer quality from character count or broad natural-language keywords. A concise response such as `- LED.` is valid when the explicit `CONTENT` contract is satisfied; the old `too_short` rule is removed from the evidence-quality decision.

`BLANK` is an explicit successful result. `VISUAL_STATUS: BLANK` is classified as **GOOD**, is cacheable, does not trigger quality recovery, and does not require the model to pad a genuinely empty page with invented detail. This is the expected result for a true blank PDF page or image with no meaningful visual content.

`UNREADABLE` is an explicit non-usable observation. `VISUAL_STATUS: UNREADABLE` is classified as weak and receives the existing one bounded strict recovery attempt without changing `VLLM_VISION_THINK`. A final response with missing `VISUAL_STATUS`, an invalid status value, or `CONTENT` without `VISUAL_EVIDENCE:` plus at least one evidence bullet is also contract-invalid and receives the same bounded retry. Persistent invalid/unreadable output continues through the V0.29.1 unavailable-evidence path rather than being cached as successful evidence.

The contract applies only to evidence-producing image/PDF Vision analysis. Internal PDF page routing keeps its separate exact `ROUTE: TEXT|DIAGRAM|SCHEMATIC|DENSE_PAGE` protocol through `outputContract=raw`, so the page classifier is not forced to emit `VISUAL_STATUS`.

Diagnostics now include `output_contract`, `visual_status`, and `contract_valid` on Vision output-quality observations. Because the prompt and accepted evidence format changed, cache generations advance to `visual-v12` and `evidence-v8`; V0.29.2 therefore does not reuse successful Vision evidence cached under the older heuristic contract. No new ENV variable is added.

## V0.29.1 Vision Recovery Safety

V0.29.1 changes the Vision quality-recovery contract. A `weak` or `empty` terminal Vision response still receives exactly one strict recovery prompt, but the retry now **preserves the configured `VLLM_VISION_THINK` value**. `VLLM_VISION_THINK=false` therefore remains `think=false` for Ollama and non-thinking for vLLM on both the first attempt and the recovery attempt; the Proxy no longer changes model mode as a side effect of output quality.

Every Vision upstream request now has an explicit deadline. `VLLM_VISION_TIMEOUT_MS` defaults to `120000` (120 seconds) and is optional to override. When that deadline expires, the Vision boundary raises `vision_service_timeout` with `transport_phase=deadline` instead of waiting for the underlying HTTP client's approximately five-minute headers timeout. The deadline is per Vision request, including the single quality-recovery retry and crop rounds.

Recoverable image-analysis failures are isolated per image. A retryable `vision_service_error`, `vision_service_timeout`, `vision_empty_output`, `vision_output_invalid`, or `vision_invalid_response` is converted into a neutral `kind=image` evidence block with `evidence_available: false` and an `error_code`; that placeholder is **not written to Media Cache**, later images in the same Claude Code request continue to be analyzed, and the Base model is explicitly instructed not to infer unseen image content from the placeholder. Invalid/corrupt media, size-policy violations, programming errors, and non-retryable provider rejections still fail normally.

Progress now exposes the recovery path instead of making the second attempt look like one long Vision call: `vision_quality_retry` reports that a strict retry is in progress, and `image_vision_unavailable` reports a recoverable image failure before processing continues. Because V0.29.0 could cache a successful recovery generated with `think=true` under a cache identity whose configured value was `think=false`, the Vision cache generation advances from `visual-v10` to `visual-v11`.

## V0.29.0 Progressive Document Read + Persistent Source Cache

V0.29.0 changes unscoped Claude Code `Read` behavior for large PDFs into **progressive disclosure**. PDFs of up to 20 source pages keep the existing full text/Vision pipeline. An unscoped PDF above 20 pages is inspected locally with Poppler and returns a bounded `kind=document_map` evidence block instead of parsing every page into the Base-model request. The map samples at most 24 physical pages, includes document metadata and page landmarks, and explicitly states that it is an index rather than complete source evidence.

The evidence contract now tells the Base model that `kind=document_map` is **not full source evidence**. If the requested answer depends on details that are not explicitly present in the map, the model must use Claude Code `Read` again with `Read.pages` for the same file. Focused `Read.pages` keeps the existing `TEXT` / `DIAGRAM` / `SCHEMATIC` / `DENSE_PAGE` routing, high-resolution PDF crop path, and page-scoped normalized evidence.

For normal Claude Code `Read` tool results, the Proxy records only an opaque SHA-256 `readSourceRef` derived from the source reference and persists the original PDF under the existing `MEDIA_CACHE_DIR` storage tree. The stored blob is named by content SHA-256, not by the user's local path. A later `Read.pages` for the same source reference first resolves that persistent original PDF and reads the requested physical page from it; if the source cache is unavailable, the Proxy safely falls back to the PDF payload returned by Claude Code and retains the existing subset-page mapping behavior.

The unscoped PDF normalized-evidence cache now uses a dedicated progressive-document namespace, so V0.29.0 cannot accidentally reuse a V0.2.28.20 whole-document cache entry. The media pipeline generation is `media-v8` and the evidence contract generation is `evidence-v7`; focused page scopes remain independently keyed. No new ENV variable is added: the progressive map threshold is an internal 20-page policy, while existing `MAX_PDF_PAGES` continues to bound detailed focused processing.

The first large scanned-PDF `Read` does not require a Vision endpoint merely to build the document map. Vision is invoked only when the model subsequently requests detailed pages that need visual interpretation. V0.29.0 intentionally does not add embeddings, BM25, a vector database, Office-document routing, or a new Claude Code tool; those remain separate future retrieval layers.

Runtime flow:

```text
Claude Code Read(large PDF)
  -> Proxy media safety / SHA-256
  -> persistent original PDF source cache
  -> local Document Map (<=24 sampled landmarks)
  -> Base model receives map only
  -> model needs detail
  -> Claude Code Read(..., pages="N-M")
  -> Proxy resolves original source cache when available
  -> existing detailed text / table / Vision / schematic pipeline
  -> page-scoped evidence cache
  -> Base model receives only requested evidence
```

## V0.2.28.20 Large Payload & Media Safety

V0.2.28.20 fixes the `Maximum call stack size exceeded` failure seen when Claude Code `Read` returns a multi-MiB PDF as Base64. The root cause was whole-string quantified-regex validation in `decodeBase64Media()`: large valid Base64 could overflow the V8 RegExp stack before the configured decoded-byte limit was even checked. The same decoder is shared by supported Base64 images, so this release treats the problem as a media-boundary issue rather than a PDF-only hotfix.

Base64 validation is now stack-safe and size-first:

```text
input string / length checks
  -> estimate decoded bytes
  -> reject oversize (413) before full validation
  -> iterative alphabet + padding validation (O(n), O(1) call stack)
  -> Buffer.from(..., 'base64')
  -> decoded-size check
  -> MIME magic validation
```

The hardened path applies to `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, and `image/webp`. An 8 MiB PDF `Read` request is covered by an end-to-end Proxy regression that verifies local media adaptation succeeds and raw Base64 never reaches Base vLLM.

Request-content walkers used by media classification, image observation, media progress, and media preflight now share a bounded structural guard. Nesting beyond 128 levels returns controlled `422 request_structure_too_deep`; cyclic object graphs return controlled `422 request_structure_cycle` instead of exhausting the Node.js call stack.

Large-payload amplification is also reduced at adjacent boundaries:

- protocol inventory skips `source.type=base64` raw `data` strings instead of scanning them for control tags;
- protocol neutralization preserves raw Base64 without regex processing;
- Web Tool diagnostic trace replaces raw Base64 with `[OMITTED_BASE64]` plus character count, estimated decoded bytes, and SHA-256;
- untouched user media history is no longer deep-cloned merely to remove Progress history;
- WebFetch-result enrichment avoids cloning the entire messages array when no fallback candidate exists;
- image normalization re-checks the normalized PNG output against the decoded-byte limit, preventing a compressed input image from expanding beyond the configured media budget.

`request_failed` diagnostics now include the current `request_stage`, `error_name`, and a bounded error stack. This makes future failures distinguishable between protocol inventory, classification, media observation, media preflight, transformation, and usage preflight instead of logging only the final error message.

The existing resource-profile limits are intentionally not changed in this release. `MAX_REQUEST_BYTES` remains the full JSON-envelope limit (including Base64 expansion and conversation history), while `MAX_DECODED_BYTES` remains the per-media decoded-content limit. No new required ENV variables are added.

V0.2.28.19 round-scoped semantic bytes/throughput, 30-second SSE liveness heartbeat, Claude Code native statusLine, Proxy-wide `▦ / ▶ / ⋯` counters, strict Final Language Repair, independent Base scheduling, and explicit-busy retry semantics remain unchanged.

## V0.2.28.19 Unified Round-Scoped Telemetry

V0.2.28.19 removes the remaining scope mismatch between the visible 30-second SSE Progress heartbeat and Claude Code native `statusLine`. Both now read the same current-model-round semantic telemetry snapshot for elapsed time, output bytes, and rolling throughput.

Each Base-model round explicitly resets its visible telemetry state:

```text
round bytes       = 0
rolling samples   = []
round elapsed     = 0s
```

Decoded semantic deltas (`thinking_delta.thinking`, `text_delta.text`, and `input_json_delta.partial_json`) advance that current-round state. Raw Base-vLLM HTTP wire bytes remain separate and continue to serve first-byte, timeout, and connection-stall diagnostics only. Request-total semantic bytes remain internal diagnostics and are not shown in the statusLine.

The 30-second Progress heartbeat is preserved for Claude Code liveness, but its displayed throughput now reads the same 5-second semantic rolling window used by statusLine. This prevents a new Managed Round from inheriting the prior round's bytes or B/s. Non-model processor phases such as Language, Compact, and Vision do not display stale Base-model bytes/rate.

The Claude Code statusLine now places Proxy-wide counters immediately after the title:

```text
◆ CC TOOL PROXY 0.2.28.19 │ ▦ 3   ▶ 2   ⋯ 1 │ ◓ 思考中 │ 59s │ 44.02 KB │ 790 B/s
```

Counter semantics are unchanged from the runtime banner: `▦` is the number of currently active Claude Code sessions known to the Proxy, `▶` is active `/v1/messages` requests, and `⋯` is the subset currently waiting in explicit vLLM busy-retry state. `⋯` does not represent vLLM's internal scheduler queue.

All statusLine elapsed values are rendered as whole seconds (`59s`, never `59.123s`). The existing `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP` runtime phase localization remains unchanged. No new ENV variables are added.

## V0.2.28.18 Strict Final Language Repair

V0.2.28.18 addresses the case where both the external Language Processor and isolated Base repair return the original source-language prose unchanged even though the Final Language Gate correctly requests a target-language repair. The classifier and V0.2.28.13 language-shift thresholds are intentionally unchanged.

The shared repair contract now makes translation an explicit mandatory action. Natural-language prose that is not already in the target locale MUST be translated; only technical tokens such as code, commands, paths, URLs, numbers, identifiers, API/ENV names, and model names may remain unchanged. Source text is isolated inside `<TRANSLATE_SOURCE>` and is explicitly treated as data rather than instructions.

Each repair backend is bounded to at most two quality attempts:

```text
External normal
  -> unchanged / non-compliant
External strict retry (once)
  -> failure
Base normal
  -> unchanged / non-compliant
Base strict retry (once)
  -> original response
```

Exact/whitespace-normalized source echoes are detected before language validation and logged as `final_language_repair_echo_detected` with `code=unchanged_output`. A retry is announced with `final_language_repair_retry`; transport, timeout, tool-call, and other backend failures do not create an unbounded retry loop. No validation threshold is relaxed.

This release also fixes `managed_model_round_completed.model_output_bytes`: the semantic-byte count is snapshotted before the round is marked inactive, so completion logs no longer report `0` after nonzero thinking/text/tool JSON deltas. Raw wire bytes remain separate and unchanged for connection-health logic.

No new ENV variables are added. The repair prompt remains localized for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`.

## V0.2.28.17 Semantic Model Output Telemetry

V0.2.28.17 separates transport activity from user-visible model-output telemetry. Raw Base-vLLM HTTP response bytes remain internal and continue to drive first-byte, connection-activity, and stall/timeout safety. They are no longer used as the `bytes` or `throughput` shown by Progress or Claude Code `statusLine`.

User-visible counters now advance only for decoded Anthropic semantic deltas:

- `thinking_delta.thinking`
- `text_delta.text`
- `input_json_delta.partial_json`

SSE `event:`/`data:` framing, JSON keys, usage metadata, block start/stop events, signatures, pings, and HTTP framing are excluded. UTF-8 byte length is used, so multilingual model output is measured by its actual encoded payload size.

The two counters are intentionally separate:

```text
WIRE BYTES
  internal only -> first-byte / connection stall / timeout diagnostics

MODEL OUTPUT BYTES
  semantic deltas only -> 30s Progress + native statusLine
```

The first semantic delta of each model round triggers an immediate nonzero telemetry update; later Progress updates remain on the existing `PROGRESS_HEARTBEAT_MS` cadence (default 30000 ms). The native status line uses a rolling 5-second semantic-output window and naturally falls back to `0 B/s` when no new model delta has arrived for that window. Managed continuation rounds reset their displayed model-output byte baseline while raw wire activity remains cumulative for connection health.

No new ENV variables are added. Localization remains unchanged for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`.

## V0.2.28.16 Claude Code Native StatusLine + SSE Liveness

V0.2.28.16 uses two independent progress channels. The existing `PROGRESS_HEARTBEAT_MS` semantic heartbeat remains enabled (default 30000 ms) and continues to append visible progress lines inside the Claude response stream. This preserves the existing long-request liveness behavior even if the native status line is disabled, unavailable, or blocked by Claude Code trust settings.

The optional native status line reads per-session, content-free telemetry from `GET /cc-tool-proxy/status/<session-id>`. The endpoint exposes only phase, elapsed time, byte/rate counters, busy attempt, short processor/tool labels, locale, and Proxy version. It never exposes prompts, model response text, tool arguments, API keys, or Processor source content, and polling the endpoint never calls Base vLLM or any auxiliary model.

Install the bundled client on the Claude Code host:

```bash
cp scripts/cc-tool-proxy-statusline.js ~/.claude/cc-tool-proxy-statusline.js
chmod +x ~/.claude/cc-tool-proxy-statusline.js
```

Then add this to `~/.claude/settings.json` (merge with existing settings rather than replacing unrelated keys):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/cc-tool-proxy-statusline.js",
    "refreshInterval": 1,
    "padding": 0
  }
}
```

The client uses `CC_TOOL_PROXY_URL` when set, otherwise it reuses `ANTHROPIC_BASE_URL`. A `/v1` or `/v1/messages` suffix is safe because the client normalizes the telemetry request back to the Proxy root. If Claude Code does not pass `ANTHROPIC_BASE_URL` into the status-line command environment, set `CC_TOOL_PROXY_URL` in the command explicitly.

Example native status line:

```text
◆ CC TOOL PROXY 0.2.28.16 │ ◓ 思考中 │ 59s │ 44.83 KB │ 760 B/s
```

The thinking glyph rotates once per Claude Code status-line refresh (`◐ ◓ ◑ ◒`) without injecting extra Messages API traffic. Runtime phases include idle, waiting, thinking, response, tool, explicit VLLM busy, compact, language repair, vision, and observational stall. The display is localized for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`; unknown locales fall back to `en-US`.

V0.2.28.15 carriage-return rendering is retired because Claude Code's TUI treats streamed text as UI content rather than direct terminal output. V0.2.28.16 therefore restores append-only heartbeat lines and delegates true redraw/animation to Claude Code's native `statusLine` renderer.

## V0.2.28.15 Progress Live-Line Renderer

V0.2.28.15 separates Proxy progress into immutable **milestone** lines and one replaceable **live line**. The first heartbeat is appended below the current milestone; later heartbeat samples replace that same line using a carriage return (`\r`) plus conservative trailing-space padding. When the model changes phase, Proxy commits the current live snapshot with `\r\n` and appends the new milestone.

Example terminal intent:

```text
◐ 主模型開始思考 · 510 B
◓ 主模型思考中 · 59s · 44.02 KB · 790 B/s
◆ 主模型開始回應 · 44.61 KB
◆ 主模型回應中 · 71s · 48.21 KB · 506 B/s
◇ 主模型建立工具動作 · 48.58 KB
```

Only the active heartbeat line is rewritten; phase transitions and tool handoff messages remain visible as history. The existing `◐ ◓ ◑ ◒` pulse therefore becomes a true low-frequency live indicator without adding a timer or increasing semantic-heartbeat cadence. This release intentionally uses **no ANSI** cursor-up or erase control sequences: replacement is limited to carriage return, CRLF milestone commit, and padding, reducing terminal/TUI compatibility risk.

The renderer is language-agnostic and keeps the existing localized telemetry for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`; unknown locales still fall back to `en-US`. Progress blocks containing carriage-return updates remain recognized by `stripProgressHistory()` and are removed before model reuse.

## V0.2.28.14 Multilingual Runtime Progress Telemetry

V0.2.28.14 replaces the ambiguous live-byte progress header with a stable localized header and moves byte telemetry into phase-aware status lines. Main-model progress now distinguishes `WAITING`, `THINKING`, `RESPONDING`, `TOOL`, and observational `STALLED` states, with elapsed time, per-round received bytes, and recent upstream throughput where meaningful.

Example zh-TW telemetry:

```text
目前處理進度：
◌ 主模型等待輸出 · 29s · 0 B
◐ 主模型思考中 · 60s · 29.82 KB · 512 B/s
◆ 主模型回應中 · 90s · 43.59 KB · 1.25 KB/s
◇ 主模型建立工具動作 · 120s · 57.63 KB · 256 B/s
⚠ 主模型資料暫停 · 30s 無新資料 · 總計 57.63 KB
```

`STALLED` is telemetry only: it is emitted only after at least one upstream byte has arrived and then no new upstream data arrives for at least one semantic-heartbeat interval. It does not cancel, retry, or resubmit an accepted model request. First-byte waiting remains `WAITING`; explicit upstream busy rejection remains the separate `VLLM BUSY` retry state.

The low-frequency pulse (`◐ ◓ ◑ ◒`) advances only when an existing semantic heartbeat is already emitted. There is **no new timer** and no increase in SSE heartbeat frequency solely for animation. The same progress contract is localized for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`, with unknown locales continuing to fall back to `en-US`. Language Repair and Vision progress use the stable `◇` glyph, while explicit busy retry uses `↻`.

## V0.2.28.13 Original-vs-Repaired Language Shift Validation

V0.2.28.13 keeps the V0.2.28.12 absolute target-language classifier as the first validation layer. When a repair is still classified as the same original source language, Proxy now compares the original text with the repaired text after code/URL/path/technical-token stripping. A repair can be accepted as `accept_by_language_shift` only when target-language characters increase by at least 12, source-language characters decrease by at least 12, and the source-language natural prose is reduced by at least 30%.

This relative validator does not override a clearly wrong target language or Chinese variant. For example, zh-CN output requested as zh-TW remains a hard failure. A repair that merely adds a short target-language preface while leaving the original English prose intact also remains a failure. Diagnostics now emit `final_language_repair_validation` with original/repaired target counts, source counts, target gain, source reduction, and source-reduction ratio.

`VLLM-CC-TOOLS-PROXY` is a transparent Claude Code gateway for local vLLM. V0.2.28.12 adds Technical-Prose Language Classification, an independent Final Language Processor, and a one-time per-session runtime banner while preserving V0.2.28.11 independent Base connections and explicit-busy retry.

## V0.2.28.12 Technical-Prose Language Classification, Language Processor, and Session Banner

V0.2.28.12 fixes Final Language Gate false positives on technical Traditional Chinese. The classifier now treats code, URLs, paths, CLI flags, model tags, environment names, snake_case, dotted identifiers, function-like names, and camel/Pascal identifiers as technical tokens instead of counting their Latin letters as ordinary English prose. Language diagnostics include natural-language Han/Latin counts and technical-token counts so `language_not_compliant` can be distinguished from a translation that was actually still English.

Final Language Repair now has an independent configuration namespace and no longer borrows `WEB_FETCH_PROCESSOR_*` settings:

```env
MODEL_RESPONSE_LANGUAGE=zh-TW
LANG_PROCESSOR_ENABLED=true
LANG_PROCESSOR_PROVIDER=ollama
LANG_PROCESSOR_URL=http://192.168.10.169:11434
LANG_PROCESSOR_MODEL=hf.co/unsloth/GLM-4.6V-Flash-GGUF:UD-Q8_K_XL
LANG_PROCESSOR_API_KEY=ollama
LANG_PROCESSOR_THINK=false
```

`LANG_PROCESSOR_ENABLED=true` enables the dedicated external repair backend. If it is disabled or its repair fails, the existing isolated Base repair remains the fallback before the original successful response is used. Ollama uses its native `/api/chat` contract with `think=true|false`; vLLM uses `/v1/chat/completions` with `chat_template_kwargs.enable_thinking=true|false`. `WEB_FETCH_PROCESSOR_*`, `CONTEXT_COMPACT_*`, and `VLLM_VISION_*` remain independent resource/configuration domains.

The first real streaming `/v1/messages` request for each Claude Code session also receives a Proxy-owned transient runtime banner such as:

```text
╭─◆ CC TOOL PROXY ─────────────────────────────╮
│  VERSION   0.2.28.12          UPTIME  2h18m  │
│  SESSIONS  3        ACTIVE  2        WAIT  0  │
│  COMPACT ● ON       LANG ● ON       VISION ● │
╰───────────────────────────────────────────────╯
```

`SESSIONS` is the number of distinct in-flight Claude Code sessions known to the Proxy, `ACTIVE` is the number of active `/v1/messages` requests, and `WAIT` is the number of requests currently in the V0.2.28.11 explicit-upstream-busy retry wait. These counters are telemetry only and do not reintroduce Proxy scheduling. The banner is shown once per session, is not sent upstream, is not token-counted or language-repaired, and is recognized by progress-history stripping so it does not become model conversation evidence.

## V0.2.28.11 independent Base connections + explicit-busy retry

V0.2.28.11 removes the Proxy-wide Base/Managed admission queue and large-context gate. Independent Claude Code connections are sent directly to vLLM; vLLM owns normal scheduler waiting and `--max-num-seqs` admission. Only an explicit transient busy rejection before generation starts is retried by that same connection at 15-second intervals while Proxy progress keeps the client informed. Once vLLM accepts the request or emits generation data, Proxy does not resubmit it.

## V0.2.28.10 external Context Compact model

V0.2.28.10 can route Claude Code `/compact` and auto-compact summarizer requests to a dedicated local model such as `qwen3.6:27b-q4_K_M-cc`. Configure `CONTEXT_COMPACT_URL` and `CONTEXT_COMPACT_MODEL` together to enable it; leave both blank to keep the V0.2.28.9 Base Compact path.

```env
CONTEXT_COMPACT_PROVIDER=ollama
CONTEXT_COMPACT_URL=http://host.docker.internal:11434
CONTEXT_COMPACT_MODEL=qwen3.6:27b-q4_K_M-cc
CONTEXT_COMPACT_API_KEY=
CONTEXT_COMPACT_THINK=false
```

Provider thinking control is intentionally different: Ollama uses native `/api/chat` with `think=true|false`, while vLLM uses `/v1/chat/completions` with `chat_template_kwargs.enable_thinking=true|false` and `preserve_thinking=false`. Backend reasoning is discarded; literal `<analysis>...</analysis>` required by the Claude Code compact prompt is preserved. Qwen backend token usage is diagnostic only and is never reused as Claude/Laguna context accounting. External compact failure falls back to the V0.2.28.9 Base Compact route.

## V0.2.28.9 Context Compact routing guard

V0.2.28.9 detects Claude Code Context Compact summarizer requests before managed-tool classification. Matching compact requests are sent directly to the configured Base vLLM with `tools` and `tool_choice` removed, preserving the original model, messages, stream mode and remaining Anthropic request fields. Their responses are returned transparently and are not subjected to Managed Final contract inspection, `control_tag_leak` repair, continuation recovery, Final Language repair, or managed progress injection.

This prevents compact summaries that legitimately contain literal protocol text such as `<analysis>...</analysis>` from being mistaken for a current Laguna runtime leak. Ordinary Agent requests with WebSearch/WebFetch continue to use the existing Managed workflow. No new ENV variables are introduced in this release.


## V0.2.28.8 cache-aware context token accounting

V0.2.28.8 changes only managed Anthropic usage accounting. The early `/v1/messages/count_tokens` result remains a provisional total so Claude Code receives context usage immediately when the proxy opens its synthetic `message_start`. When upstream vLLM later reports Anthropic cache-aware usage, the input-side tuple (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) is treated atomically and replaces the provisional representation instead of being merged field-by-field.

For example, a 197,500-token prompt may first appear as `input_tokens=197500`, then vLLM may report `input_tokens=5000` plus `cache_read_input_tokens=192500`. Both represent the same 197,500-token prompt. V0.2.28.7 could combine those representations into an invalid 390,000-token total; V0.2.28.8 preserves the correct 197,500 total. Output-only usage deltas keep the last authoritative input tuple.

No ENV variables are added. This release does not add the planned external Context Compact model and does not modify Managed Continuation, WebFetch Processor, Final Language Repair, PDF/Vision, reasoning, token budget, or cache generations.

## V0.2.28.7 compact main-model phase progress

V0.2.28.7 makes long model rounds easier to diagnose without exposing model reasoning content. The Anthropic SSE collector now observes meaningful generation phase transitions from protocol structure only: `thinking` / `thinking_delta` maps to **思考**, `text` / `text_delta` maps to **回應**, and `tool_use` / `server_tool_use` / `input_json_delta` maps to **工具**. Before the first content phase is known, the round is **等待**. Signature deltas, message deltas, block stops, pings, and other protocol-only events do not create user-visible phases.

Managed heartbeat lines are deliberately compact and always remain one physical line, for example:

```text
主模型處理中 60 秒（思考，29.82 KB）…
主模型處理中 90 秒（回應，43.59 KB）…
主模型處理中 120 秒（工具，57.63 KB）…
```

Phase transitions are emitted immediately when the progress block is visible, using short status lines such as `主模型開始思考（494 B）…`, `主模型開始回應（43.59 KB）…`, and `主模型建立工具動作（57.63 KB）…`. The byte value remains the existing **per-model-round upstream byte count**; it is not the payload size of the named phase. Transport first-byte activity remains available through `managed_model_first_byte_received` diagnostics but no longer adds a redundant user-visible first-byte line.

Each managed model round resets to `waiting`, including controlled-continuation rounds, so the displayed byte count and phase do not inherit the previous round. Safe `managed_model_stream_phase_changed` diagnostics record only phase metadata, elapsed time, and per-round bytes; no thinking/text/tool content is logged.

No new ENV variables are added. Model sampling, reasoning/token budgets, continuation compression, Final Language Repair, PDF/Vision routing, and media cache semantics are unchanged. Cache generations remain `media-v7` / `visual-v10` / `evidence-v6`.

## V0.2.28.6 Final Language direct-segment repair

V0.2.28.6 removes the model-visible `<<<VCC_LANG_SEGMENT_*>>>` protocol from Final Language Repair. When the Final Language Gate detects a final answer in the wrong language, Proxy itself owns the original text-block indices and invokes the configured repair backend once for each text block. Each backend request contains one translation-only instruction plus one plain-text source segment; the model is never asked to preserve synthetic segment markers or reconstruct block mapping.

External repair continues to reuse the existing `WEB_FETCH_PROCESSOR_*` configuration and remains tool-less/non-thinking. For multiple text blocks, requests are performed in source order under the same processor admission lease, and Proxy deterministically reassembles returned text into the original Anthropic content-block positions. Base fallback uses the same direct single-segment contract in an isolated request with no original Claude Code conversation, no tools, and thinking disabled.

Every returned segment still passes the existing Final Language Gate post-validation. Empty output, tool calls, invalid transport payloads, or output that remains in the wrong language cause the current backend to fail and preserve the established external → Base → original-response fallback chain. Safe processor diagnostics now include `segment_index`, `segment_count`, input/output character counts, and elapsed time without logging translated content.

No new ENV variables are added. Media/Vision cache generations remain `media-v7` / `visual-v10` / `evidence-v6`.

## V0.2.28.5 managed continuation state compression

V0.2.28.5 participates **only after the existing Managed Loop gate has already selected continuation recovery** because a model round did not produce a valid next tool action or deliverable final answer. Normal managed rounds, normal tool execution, and normal final responses never invoke the continuation compressor.

The eligible state is deliberately narrow: only the immediately preceding model-generated `thinking` blocks and unfinished visible `text` blocks are collected. `tool_use`, `tool_result`, user/system messages, PDF/Vision evidence, network results, and all other authoritative conversation evidence are **not compressed and are not sent to the external processor**. The untouched original conversation remains the authority for tool/evidence facts; the compacted payload is explicitly labeled non-authoritative prior model working state.

Continuation preparation is size-aware. State up to 24,000 characters is preserved in full. State from 24,001 through 96,000 characters uses deterministic HEAD+TAIL retention. State above 96,000 characters uses overlapping segmented compression: approximately **24K-character windows with 4K overlap**, processed sequentially so cross-boundary intent is retained without exposing unrelated protocol state. A recent sanitized raw model-state tail is always retained alongside compressed historical working state.

Large-state compression reuses the existing `WEB_FETCH_PROCESSOR_*` auxiliary processor configuration, admission lane, credentials, provider controls, and timeout; V0.2.28.5 adds no continuation-specific ENV. The compressor is tool-less and schema-constrained: it may extract working assumptions, considered decisions, rejected options, unresolved items, and intended next actions, but it may not verify evidence, invent facts, choose tools, or continue the task itself. If the external processor is unavailable, times out, returns malformed output, or tries to emit a tool call, controlled continuation falls back to deterministic HEAD+TAIL state and continues instead of failing the request.

Progress now makes preservation visible rather than implying that a long round was discarded. Diagnostics include `managed_continuation_state_preparation_started`, per-chunk compression events, `managed_continuation_compression_failed`, and `managed_continuation_state_preserved`, including candidate/preserved sizes and whether compression/truncation occurred without logging the actual working-state content.

This release does not change media evidence semantics, so cache generations remain `media-v7`, `visual-v10`, and `evidence-v6`.

## V0.2.28.4 PDF schematic tile isolation + Vision transport diagnostics

V0.2.28.4 changes only the high-cost SCHEMATIC region workload. Deterministic overlapping tiles are still rendered from the original PDF, but **one tile now equals one Vision request** and tiles are analyzed sequentially. `MAX_VISUAL_PAGES_PER_BATCH` continues to apply to ordinary DIAGRAM/DENSE_PAGE work; it no longer groups schematic tiles into one multi-image request.

An expected tile-level Vision failure (`vision_*` `HttpError`) is contained at the tile boundary. The Proxy emits `pdf_schematic_tile_failed`, records a bounded uncertainty/evidence-gap marker for that source_id, and continues later tiles. Unexpected programming errors are not swallowed. This keeps partial schematic evidence usable instead of turning one slow or failed tile into a whole-document 502. No new ENV variable is added.

Vision transport failures keep the existing public `vision_service_error` contract but now preserve safe root-cause metadata such as `transport_code=UND_ERR_HEADERS_TIMEOUT` and `transport_phase=headers`. Connection refusal/reset and body/header timeout causes are distinguished without logging request bodies, image bytes, or raw model output. The user-facing transport message no longer reports every timeout as a generic inability to reach the service.

The PDF classifier is also stricter: SCHEMATIC is reserved for visible electronic circuit/wiring evidence such as reference designators, component symbols, pins, nets, and wires. Flow charts, screenshots, UI procedures, architecture/block diagrams, sequence diagrams, and ordinary process drawings are explicitly not SCHEMATIC.

Because schematic evidence granularity and the classifier prompt changed, cache generations advance to `media-v7`, `visual-v10`, and `evidence-v6`. Media identity is unchanged; prior visual/evidence cache entries are intentionally invalidated.

## V0.2.28.3 Vision Evidence Quality Gate + Adaptive Thinking Recovery

V0.2.28.3 closes the gap left by V0.2.28.2 where any non-empty Vision response was treated as usable. A production capture showed `content_chars=19`, `thinking_chars=0`, `usable_content=true`, followed immediately by `media_cache_write`; later requests repeatedly hit that low-information evidence. The Vision boundary now classifies terminal output as `good`, `weak`, or `empty` (tool-call rounds remain separate). Refusal/access-limitation phrases, metadata-only output, and very short non-observable output are `weak` and cannot be cached. Concise concrete observations remain valid.

On the first `weak` or `empty` terminal result, the Proxy emits `vision_output_quality` and `vision_quality_retry`, switches the recovery attempt to `think=true`, and supplies a bounded recovery instruction asking for concrete observable evidence. Native `message.thinking` and inline `<think>...</think>` remain stripped before evidence production. If the recovery output is still weak, the request fails with `vision_output_invalid`; persistent empty output continues to fail with `vision_empty_output`. Neither failure path reaches Media Cache. No `/nothink` injection is reintroduced and no new ENV variable is added.

Safe diagnostics now make transport success distinct from evidence quality: `vision_output_observed` reports output shape, `vision_output_quality` reports only quality/reason/cacheability, and `vision_quality_retry` reports the bounded transition from the configured thinking state to recovery thinking. Raw Vision content and reasoning are never logged.

Because V0.2.28.2 may already contain cached non-empty weak evidence, cache generations advance to `media-v7`, `visual-v9`, and `evidence-v5`. Media identity is unchanged; visual/evidence cache entries are intentionally invalidated.

## V0.2.28.2 Vision empty-output contract hotfix

V0.2.28.2 removes the manual `/nothink` prefix that V0.2.28.1 injected into GLM system messages. Native Ollama Vision now relies on the provider-native `think=false` request field, Ollama OpenAI-compatible language repair keeps `reasoning_effort=none`, and vLLM keeps `chat_template_kwargs.enable_thinking=false` / `preserve_thinking=false`. Response-side reasoning sanitization remains authoritative: native `message.thinking` and inline `<think>...</think>` content are stripped before evidence production. No new ENV variable is introduced.

Vision HTTP success is no longer sufficient for analysis success. Every Vision response emits safe `vision_output_observed` diagnostics containing only output-shape counts (`content_chars`, `thinking_chars`, `tool_call_count`, `control_tag_count`, `usable_content`). When a request finishes without tool calls and has no usable visible content after reasoning stripping, the Proxy performs exactly one controlled retry and emits `vision_empty_output_retry`. A second empty result raises `vision_empty_output`; no synthetic fallback evidence is produced, so the failed analysis is not written to Media Cache.

Because V0.2.28.1 may already have cached synthetic empty Vision evidence, cache generations advance to `media-v7`, `visual-v8`, and `evidence-v4`. Media identity is unchanged; only visual/evidence cache entries are invalidated. Final-language fallback progress now distinguishes the external attempt from Base fallback instead of showing the same conversion message twice.

## V0.2.28.1 GLM output contract hardening

V0.2.28.1 fixes a production case where Final Language Gate correctly detected an English final answer, invoked the configured external GLM translator, received HTTP 200 with valid segment markers, and still delivered English because the repaired text was never classified again. Every repair backend is now post-validated with the existing language classifier. If the repaired text clearly still requires repair, the backend is rejected with `language_not_compliant`; external repair falls back to isolated Base repair, and Base repair falls back to the original successful answer only when no repair backend can produce acceptable output. Short or code-heavy results that remain classifier-`uncertain` are not rejected merely for lacking enough prose signal.

GLM non-thinking control is now provider-aware. Native Ollama Vision keeps `think=false`; when the configured Ollama model is GLM and thinking is disabled, the system instruction is also prefixed with `/nothink` so the GLM chat template receives its native no-think hint. The Ollama OpenAI-compatible language processor keeps `reasoning_effort=none`, adds the same `/nothink` hint for GLM, and still omits vLLM-only `chat_template_kwargs`. vLLM processors continue to use `chat_template_kwargs.enable_thinking=false` / `preserve_thinking=false`. No new ENV variable is introduced.

Vision responses are sanitized at the Vision boundary before they become document/image evidence. Native `message.thinking` remains internal and is never copied into evidence; complete `<think>...</think>` regions and orphan think tags are removed from visible Vision content. Raw response diagnostics still report `visual_control_tags_detected`, while actual removals additionally emit `visual_reasoning_stripped`. Visible Markdown, crop tool calls, source lineage, and recursive crop behavior are preserved.

Because old cached Vision evidence may contain escaped reasoning material, cache generations advance to `media-v7`, `visual-v7`, and `evidence-v3`. Media identity is unchanged; only visual/evidence cache entries are intentionally invalidated.


## V0.2.28 IMAGE wire-contract observability

V0.2.28 formalizes the IMAGE payload contract already supported by the recursive media adapter. Standard Claude Code `Read(image)` results arrive as nested `tool_result.content[]` image blocks; direct user images and generic tool-result images share the same media adapter but now retain distinct provenance in diagnostics.

The Proxy emits a safe `image_payload_observed` event before image analysis. It records origin (`read`, `direct`, or `tool_result`), parent/source type, media type, decoded byte count, structural block/source key inventories, safe dimension metadata, Read basename/hash, and sanitized source-reference basename/hash when present. It never logs raw Base64, image bytes, or full local paths.

On a cache miss, `image_payload_normalized` additionally records the actual decoded image dimensions seen by the Proxy and the normalized Vision dimensions. This makes it possible to determine whether Claude Code resized/recompressed an image before the Proxy received it. Media cache metadata stores received and normalized dimensions for troubleshooting.

The existing IMAGE analysis path is unchanged: request-scoped media handle → image normalization → `VisualAssetRegistry` → Vision → bounded recursive crop → normalized text evidence → Media Cache → Base model. No new ENV is introduced. `media-v7`, `visual-v6`, and `evidence-v2` remain unchanged because the analysis/evidence semantics did not change.

## V0.2.27.3 per-round continuation byte accounting hotfix

V0.2.27.3 fixes the managed-loop progress display after a controlled continuation. The Proxy has always kept the Base upstream byte counter cumulative for the whole request, while each managed model round also records its own `startBytes`. V0.2.27.2 correctly logged `round_received_bytes`, but the visible `modelWaiting` and `modelFirstByte` status still rendered the request-wide cumulative byte count. After a thinking-only response of roughly 70 KB, a continuation could therefore start at `70 KB` even before that new round had received any data.

Visible model-round progress now uses `round_received_bytes = max(0, request_received_bytes - startBytes)`. A continuation heartbeat therefore restarts at `0 B`, and the first returned chunk reports only bytes received in that continuation round. The request-wide cumulative counter is **not reset**: diagnostics still retain cumulative `received_bytes` / `upstream_received_bytes`, and `progress_sse_sent` also exposes the current `round_received_bytes` while a model round is active.

The dedicated progress-block header may continue to represent request-wide cumulative traffic; only text explicitly describing the **current model round** is reset to the round-local counter. This keeps throughput diagnostics intact while making Claude Code visible progress semantically consistent with the per-round elapsed timer.

This hotfix adds no ENV variable, changes no managed-loop recovery policy, and does not modify PDF routing, `Read.pages`, Vision, cache, evidence, language repair, or WebSearch/WebFetch behavior. Cache/evidence generations remain `media-v7`, `visual-v6`, and `evidence-v2`.

## V0.2.27.2 native Read.pages focused PDF refinement

V0.2.27.2 lets the main model reuse Claude Code's native PDF `Read.pages` request as a focused reread path. The Proxy correlates the assistant `Read` tool use with the returned PDF `tool_result`, normalizes the requested page scope, and keeps that scope attached to the media occurrence without exposing the original local file path to evidence or cache metadata. No custom Claude Code tool is introduced.

A focused read such as `Read(file_path="board.pdf", pages="42")` now receives a **page-scoped cache** identity derived from the existing media fingerprint plus the canonical page scope. A cached whole-document result therefore cannot satisfy a focused reread, while a repeated reread of the same page range can reuse the focused evidence. The global cache generations remain `media-v7`, `visual-v6`, and `evidence-v2`, so existing whole-document cache entries remain valid.

The PDF parser processes only the requested logical pages when the received payload is the full source PDF. If Claude Code supplies a subset PDF containing only the requested pages, the Proxy maps its physical pages back to the original logical page numbers in evidence. Focused reads are bounded by the number of requested pages rather than the total source page count, allowing a small reread from a larger document while retaining the existing per-request limits.

Focused PDF processing keeps the existing `TEXT` / `DIAGRAM` / `SCHEMATIC` / `DENSE_PAGE` routing. A focused schematic page still uses overview, overlapping tiles, page merge, and the existing Vision recursive crop against the PDF received by that `Read.pages` call. Whole-document cache hits no longer suppress live progress for a focused cache miss: cache preflight is page-scope-aware before choosing the managed or cached fast path.

This release deliberately does not persist raw PDFs across turns, add a region/bbox Claude Code tool, add ENV variables, or change OCR/Vision providers. Claude Code selects the page with native `Read.pages`; the existing Vision worker selects finer regions through recursive crop when needed.

## V0.2.27.1 live PDF/media progress hotfix

V0.2.27.1 fixes the V0.2.27 progress-transport boundary where PDF/Vision preprocessing already emitted semantic progress internally but `proxy-server.js` buffered those events until media adaptation and exact `/v1/messages/count_tokens` had both completed. Claude Code therefore appeared idle during long PDF work and then received the accumulated progress all at once.

For streamed media cache misses, the Proxy now performs one **sanitized bootstrap `/v1/messages/count_tokens`** request before media adaptation. PDF/image blocks are replaced only in that temporary counting clone by bounded text markers; raw Base64, `proxy_file`, file paths, cache keys, and raw media never enter Base vLLM. The returned non-media context count is used as the conservative initial `message_start.usage`, allowing `ProgressStream` to open before Vision preprocessing begins.

Once the stream is open, PDF/image preprocessing updates are delivered live while Vision is still running. After media has been converted into normalized text evidence, the Proxy performs the existing exact `/v1/messages/count_tokens` preflight on that evidence and emits the **exact cumulative `message_delta.usage`** before continuing to Laguna. Large-context admission continues to use this exact post-normalization count rather than the bootstrap lower-bound.

The V0.2.27 schematic path also gains finer progress phases: `pdf_schematic_tile_render` reports each deterministic tile as it is rendered from the original PDF, and `pdf_schematic_tile_analyze` reports each Vision tile batch before `pdf_schematic_merge`. Existing page classification, overview, recursive crop, merge, cancellation, and managed SSE lifecycle remain unchanged.

This hotfix adds no ENV variable, no OCR engine, and no evidence-format change. The cache/evidence generations therefore remain `media-v7`, `visual-v6`, and `evidence-v2`.

## V0.2.27 routed schematic PDF pipeline

V0.2.27 changes PDF routing from the V0.2.26 low-text/raster-only heuristic into a bounded page classifier with exactly four routes: `TEXT`, `DIAGRAM`, `SCHEMATIC`, and `DENSE_PAGE`. When Vision is configured, every PDF page receives a low-resolution classification overview so text-rich vector-only schematics are no longer silently treated as native-text-only pages. Classifier failures and unsupported results conservatively fall back to `DENSE_PAGE`.

`TEXT` keeps sufficient native Poppler text unchanged; low-text/scanned text pages use Vision transcription. `DIAGRAM` uses a full-page overview plus the existing recursive ROI crop mechanism. `DENSE_PAGE` is the conservative mixed-content fallback. No OCR engine or new ENV variable is introduced.

`SCHEMATIC` uses a dedicated path: a 300–400 DPI full-page overview, deterministic **overlapping tiles** rendered directly from the original PDF at 360 DPI, Vision extraction of observable components/pins/nets/power/clock/reset relationships, and a page-level evidence merge that removes exact overlap duplicates while retaining source identifiers and uncertainty. Tiles are registered as depth-0 regions, so a model-requested crop from a tile still maps back to the original PDF and uses the existing bounded 600–720 DPI recursive crop policy.

The Proxy remains an evidence-preprocessing layer: it does not perform Device Tree, API, driver, or other engineering conclusions. Laguna receives neutral text evidence and remains responsible for engineering reasoning. Flow charts, timing diagrams, block diagrams, pinouts and similar content remain under the generic `DIAGRAM`/`DENSE_PAGE` paths in this release rather than receiving dedicated subtypes.

Because routing, visual prompts, schematic region evidence and page merge semantics changed, the media cache contract advances to `media-v7`, `visual-v6`, and `evidence-v2`. Existing vLLM/Ollama Vision provider selection and all existing ENV names are preserved.

## V0.2.26.5 Final Language Gate boundary hotfix

V0.2.26.5 fixes two narrow Final Language Gate boundaries found in production logs.

The exclusive `native_web_search` fast lane now **bypass Final Language Gate** completely. That lane is a Claude Code internal WebSearch child/result workflow rather than the user's final assistant answer, so its `end_turn` text is returned unchanged to Claude Code. It no longer calls the External Processor or Base language-repair fallback merely because the internal WebSearch result is English. Normal `managed` final answers and ordinary final `/v1/messages` responses keep the V0.2.26.4 language gate behavior.

The zh-TW / zh-CN deterministic classifier now recognizes more common variant-specific characters and can classify short, explicit Chinese text from four Han characters onward when at least two same-direction variant markers clearly dominate the opposite variant. For example, `这是测试。` is treated as zh-CN when the target is zh-TW, and `這是測試。` is treated as zh-TW when the target is zh-CN. Code fences, inline code, URLs and path-like literals remain excluded from language sampling, and mixed technical Chinese continues to use the conservative pass/uncertain policy when variant evidence is not clear.

No ENV variable, Laguna chat template, WebFetch/Vision pipeline, timeout policy, scheduling rule, or External→Base→original repair fallback order is changed. The external release label is `0.2.26.5`; npm-valid package metadata is `0.2.26+hotfix.5`.

## V0.2.26.4 Final Language Gate

V0.2.26.4 changes `MODEL_RESPONSE_LANGUAGE` from a Base-model generation instruction into the **Final Presentation Language**. The V0.2.26.2 `system` language contract and V0.2.26.3 generation-adjacent user tail are retired from the runtime request path. Laguna therefore receives the caller's original system/user/tool context without Proxy-added response-language prompting and can focus on reasoning, coding and tool use.

The language gate runs only after a candidate final Anthropic Message exists. It never rewrites `thinking`, `tool_use`, server-tool blocks, tool results, or intermediate managed rounds. A conservative deterministic detector removes code fences, inline code, URLs and path-like literals from its language sample before deciding whether the visible prose is clearly non-compliant. Technical or mixed-language answers that are compliant or uncertain pass through unchanged.

When repair is required, the fallback order is:

```text
Final visible text
→ External Processor (when WEB_FETCH_PROCESSOR_* is configured and enabled)
→ isolated Base vLLM language repair if External is unavailable or fails
→ original Laguna final response if Base repair also fails
```

The External Processor reuses the existing `WEB_FETCH_PROCESSOR_PROVIDER`, URL, model, API key and thinking setting; no language-specific ENV variables are added. The Base fallback is a direct single-shot internal request with no original Claude Code system/history/tools, no agent loop, and thinking disabled. Both repair backends receive only marker-delimited final text segments under a language-only rewrite contract that preserves meaning, Markdown, code, commands, paths, URLs, numbers and identifiers. Segment-count or empty-output mismatches are treated as repair failures rather than accepted as modified content.

For streaming `/v1/messages`, the Proxy buffers the Base Anthropic SSE into a complete final Message before emitting the final response, because language compliance cannot be decided after untranslated text has already been sent to Claude Code. Existing progress/keepalive and Base lifecycle observability are preserved while buffering, including request start, headers received, first model event, usage and stream completion.

`MODEL_RESPONSE_LANGUAGE` remains the only response-language setting. WebFetch Processor and Vision evidence-language behavior are unchanged. Language repair is presentation-only: an External/Base repair failure must never turn an otherwise successful Laguna task into an API error. The external release label is `0.2.26.4`; npm-valid package metadata is `0.2.26+hotfix.4`.


## V0.2.26.3 generation-adjacent language tail

V0.2.26.3 keeps the V0.2.26.2 locale-native `system` language contract and adds one compact **generation-adjacent language tail** to the latest `user` turn in the request clone sent to Base vLLM. This increases recency without modifying the original Laguna chat template or adding tool/protocol wording.

For `MODEL_RESPONSE_LANGUAGE=zh-TW`, the tail is:

```text
若使用者未明確要求其他語言，請以繁體中文（zh-TW）撰寫給使用者看的回答。
```

Equivalent one-line tails are native-language localized for `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`. The tail is ephemeral: the Proxy does not persist it back into the Claude Code transcript. Before every managed model round, the Proxy removes any previous injected copy from the request clone and re-anchors exactly one copy on the **latest user turn**, including a user turn containing a `tool_result`. This keeps the reminder adjacent after WebSearch/WebFetch or other managed-tool continuation rounds instead of leaving it behind in older history.

Managed `/v1/messages/count_tokens` usage preflight is re-anchored after native-Web normalization as well, so token counting and the first Base-model inference round see the same language tail. V0.2.26.3 does not change WebFetch Processor or Vision/Ollama language instructions, tool schemas, tool lifecycle, Media/Vision processing, activity-aware timeout policy, scheduling, or ENV names. The external release label is `0.2.26.3`; npm-valid package metadata is `0.2.26+hotfix.3`.

## V0.2.26.2 native-language visible-output contract

V0.2.26.2 changes only the Main/Base-model `MODEL_RESPONSE_LANGUAGE` instruction. The Proxy still appends the instruction at the end of the transformed Anthropic `system` prompt with the existing blank-line boundary, but each supported locale now expresses the rule in that locale's own language instead of using the previous English `Respond in ...` sentence.

For `MODEL_RESPONSE_LANGUAGE=zh-TW`, the appended instruction is:

```text
在 think 思考區塊之外，所有使用者可見的自然語言內容都必須使用繁體中文（zh-TW）。
除非使用者明確要求，否則不得切換為其他語言。
```

The wording intentionally constrains only **user-visible natural-language content**. It does not mention tool calls, JSON, protocol syntax, code, paths, or identifiers. It also refers to the `think` reasoning block without embedding literal `<think>` / `</think>` control-tag syntax into the system prompt, avoiding interference with the Proxy protocol-anomaly scanner and Laguna control-tag handling.

The same compact contract is localized for `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`. The original Laguna chat template is not modified. WebFetch Processor instructions, Vision/Ollama prompts, Proxy progress/status localization, WebSearch/WebFetch, Media/Vision, timeout policy, and scheduling are unchanged. No new ENV variable is introduced. The external release label is `0.2.26.2`; npm-valid package metadata is `0.2.26+hotfix.2`.

## V0.2.26.1 activity-aware managed timeout hotfix

V0.2.26.1 changes the managed Base-model deadline from an unconditional round wall-clock cap into a **first-byte deadline** when upstream response activity is observable. `MANAGED_MODEL_ROUND_TIMEOUT_MS=360000` still protects TTFT: if the current round produces no Base-vLLM response byte within six minutes, the request fails with `managed_model_timeout`.

Once the current round receives its first upstream response byte, the first-byte deadline is disarmed for that round. Liveness is then controlled by the existing 90-second **streaming inactivity** detector. Every new upstream response-body chunk advances `lastByteAt`; only a full 90 seconds with no new bytes after streaming has begun raises `managed_model_stall_timeout`. A model that continues producing bytes may therefore run longer than six minutes and complete normally.

The whole-task hard deadline is now **disabled by default**. `MANAGED_TASK_TIMEOUT_MS` is retained only as an opt-in compatibility/safety override: unset, blank, or `0` means disabled; a positive configured value enables the previous absolute task deadline. There is no default `1800000` value in `.env.example` or Compose. Model token/context limits, per-tool/processor timeouts, loop protection, client cancellation, and disconnect handling remain the normal termination boundaries.

No new ENV variable is introduced. V0.2.26 Media/Vision behavior and all WebSearch/WebFetch/scheduling behavior remain unchanged.

## V0.2.26 recursive Vision evidence pipeline

V0.2.26 moves managed media adaptation **before Base `/v1/messages/count_tokens`**. Raw Claude Code PDF/image blocks are resolved through the media cache and configured Vision provider first, converted into neutral text evidence, and only then sent to Base vLLM for token counting, large-context classification, and Laguna inference. This prevents Base `/count_tokens` from receiving `image`, `proxy_file`, Base64, or raw PDF content merely to estimate usage. Existing `VLLM_VISION_PROVIDER=ollama` routing therefore remains isolated from the Base model. No new ENV variable is required.

PDF visual processing is now selective rather than unconditional. Pages with sufficient native text and no raster-image inventory are kept as native-text evidence; low-text pages or pages reported by `pdfimages -list` as containing raster images are selected for Vision. Vector-only diagrams on otherwise text-rich pages are not automatically detected by this heuristic. If `pdfimages -list` is unavailable, PDF processing continues and records `pdf_image_inventory_unavailable`.

Selected PDF pages use an **adaptive 220–320 DPI** overview raster targeting about 3500 pixels on the page long edge; A4 resolves to about 299–300 DPI. The 4096-pixel normalization ceiling remains a final VLM safety bound. If the Vision model requests more detail, the Proxy does not enlarge the overview bitmap: it maps the requested bbox back to the **original PDF** and rerenders that region at higher effective resolution. First-level PDF crops are bounded at 600 DPI and deeper recursive crops at 720 DPI.

Normal JPEG/PNG files use the same recursive observation contract, but without pretending that DPI can create source detail. The overview may be normalized for VLM input while all crops are cut from the **original image pixels**. Crop presentation targets about 2400 pixels on the long edge with interpolation bounded to at most 4x; if the original pixels do not contain enough information, the Vision worker is expected to report uncertainty instead of guessing.

Every successful crop is now registered as a first-class visual asset with `source_id`, `root_source_id`, `parent_source_id`, `depth`, and a root-coordinate bbox. The Vision model can therefore request multiple different regions and can crop a previous crop again. The internal recursive crop loop is bounded to 3 crop rounds, depth 3, no more than 4 crop requests in one model round, and 8 derived crops per root asset. Raw images are not handed to Main Laguna as a fallback when Vision cannot read them; successful media handling ends in text evidence, while unrecoverable Vision service errors remain explicit request errors.

Vision routing is now observable without exposing image bytes. Each provider call records `vision_upstream_request` and `vision_upstream_response` with safe fields such as `provider`, `backend_host`, `endpoint_path`, `model`, image count/dimensions, HTTP status, and elapsed time. With the existing Ollama configuration this makes `/api/chat` routing directly visible in Proxy logs instead of requiring inference from vLLM/Ollama logs.

Because raster policy, recursive crop lineage, and visual prompt behavior changed, the media cache contract advances to `media-v6` and `visual-v5`. Old 180-DPI/previous-prompt evidence will not silently satisfy the new pipeline.

## V0.2.25.2 first-byte progress hotfix

V0.2.25.2 fixes a sampling-window problem in the byte-progress UI. V0.2.25.1 already changed managed Base-model rounds to `stream:true`, but semantic progress was still sampled on the normal heartbeat cadence. A request could therefore show `0 B` at 30 and 60 seconds, receive its first upstream bytes at 65 seconds, and finish at 87 seconds before the 90-second heartbeat ever had a chance to display the nonzero counter.

For each managed model round, the Proxy now records the first upstream response chunk. If the progress block is already visible, that first chunk immediately emits one localized update such as:

```text
目前處理進度（已收到 0 B）：
主模型仍在處理本輪請求，已執行 60 秒（已收到 0 B）…
主模型已開始回傳資料，已執行 65 秒（已收到 284 B）…
```

Only the first upstream chunk of a model round triggers this immediate update. Later chunks continue to be sampled by the existing semantic heartbeat, so the Proxy does not generate one UI update per token/SSE chunk. Fast requests that never exposed a progress block remain quiet and do not flash a completion-only progress block.

A new `managed_model_first_byte_received` diagnostic records `elapsed_ms`, `chunk_bytes`, request-scoped `received_bytes`, and `round_received_bytes`. `progress_sse_sent` diagnostics now also include `upstream_received_bytes` and `model_elapsed_ms`, making it possible to distinguish outgoing progress-packet size from actual Base-vLLM response activity.

V0.2.25.2 does not change the V0.2.25.1 managed SSE transport, 90-second stall detector, hard model deadline, native WebSearch fast lane, large-context gate, WebFetch/Ollama Processor routing, response-language policy, or Claude Code-owned Web lifecycle. No new ENV variable is required.


## V0.2.25.1 managed SSE streaming hotfix

V0.2.25.1 fixes a transport mismatch in the managed model loop. V0.2.24 introduced cumulative Base-vLLM response-byte progress, and V0.2.25 used the same `receivedBytes` / `lastByteAt` activity to distinguish a live response from a stalled one, but the managed upstream adapter still forced `stream:false`. A local vLLM could therefore keep decoding tokens while the Proxy saw `0 B` until the final JSON response was complete.

Managed Base-model rounds now request `stream:true`. The Proxy consumes the Anthropic SSE internally and reconstructs the same complete Anthropic Message object that the existing Managed Loop already expects. The reconstruction covers `message_start`, thinking/text deltas, streamed tool input JSON, usage, stop state, and `message_stop`; Claude Code still receives the same Proxy-managed final/tool lifecycle as before.

The raw Base-vLLM HTTP response-body chunks continue to update the request-scoped byte counter before SSE decoding. As a result, progress can now change while Laguna is still generating:

```text
目前處理進度（已收到 0 B）：
主模型仍在處理本輪請求，已執行 30 秒（已收到 1.22 KB）…
主模型仍在處理本輪請求，已執行 60 秒（已收到 2.31 KB）…
```

This also makes the existing `managed_model_stall_timeout` meaningful for a streaming-capable Base vLLM: after the current round receives its first upstream response bytes, `lastByteAt` advances as later SSE chunks arrive; a full 90-second response-body silence can then be detected before the hard `MANAGED_MODEL_ROUND_TIMEOUT_MS` deadline. TTFT remains protected because the stall detector does not arm before the first response byte.

For compatibility, if an upstream ignores `stream:true` and returns one valid JSON Message, the Proxy still accepts it. In that compatibility path, live token-byte progress is naturally unavailable until the JSON body begins arriving. No new ENV variable is required.

V0.2.25.1 does not change the native WebSearch fast lane, 100K+ large-context gate, WebSearch forced choice, WebFetch/Ollama Processor routing, response-language policy, or Claude Code-owned WebSearch/WebFetch lifecycle.

## V0.2.25 multi-Agent research scheduling

V0.2.25 targets Claude Code workloads where several subagents research in parallel and repeatedly enter WebSearch/WebFetch. It keeps the existing general managed concurrency limit, but removes the worst head-of-line blocking patterns observed with 20K–140K-token Agent turns.

### Native WebSearch fast lane

An exclusive Claude Code native `web_search_YYYYMMDD` child request now uses a dedicated one-slot admission lane instead of the general managed queue. This lane still preserves V0.2.23.2 behavior: the first model round sees only normalized `web_search` with forced `tool_choice`, SearXNG executes the search, and the continuation returns to `tool_choice=auto`. The fast lane prevents a tiny Search dependency from waiting behind two long general Agent turns.

The fast lane is intentionally narrow. Main-agent `WebSearch`/`WebFetch`, native WebFetch, mixed tools, media work, and ordinary managed requests remain on their existing paths.

### Large-context gate

For streamed managed requests whose preflight usage is at least `100000` input tokens, V0.2.25 applies an internal one-slot large-context gate before general managed admission. This prevents two 100K+ prefills from simultaneously consuming the normal two managed slots and amplifying vLLM latency. Smaller managed requests may still use the remaining general capacity. No new ENV setting is required.

`/health` now exposes `native_web_search` and `large_context` lane state in addition to the existing `managed`, `vision`, and `web_fetch_processor` state. Diagnostics include `managed_request_classified`, `large_context_job_enqueued`, `large_context_job_admitted`, and a `lane` field on `managed_job_enqueued` / `managed_job_admitted`.

### Queue time vs model time

Progress heartbeat time is now phase-aware. Time spent waiting for admission is reported as queue time; when a Base-model round actually starts, the model timer starts from zero. The cumulative Base-vLLM byte counter from V0.2.24 remains request-scoped.

Example:

```text
目前處理進度（已收到 0 B）：
正在等待主模型執行資源，已排隊 60 秒，目前前方有 1 個任務…
任務已開始處理…
主模型仍在處理本輪請求，已執行 30 秒（已收到 1.22 KB）…
```

### Conservative response-body stall detection

The existing `MANAGED_MODEL_ROUND_TIMEOUT_MS` remains the hard model-round deadline. V0.2.25 additionally watches Base-vLLM response-body activity with an internal 90-second stall window. The stall timer is **not armed during TTFT**: it begins only after the current model round has received its first response byte. If response bytes begin and then stop for the full stall window, the round fails with `managed_model_stall_timeout`. This avoids misclassifying a long non-streaming JSON TTFT as a stalled response.

WebFetch/Ollama Processor concurrency remains unchanged at the configured `WEB_FETCH_PROCESSOR_CONCURRENCY`; V0.2.25 does not move WebFetch Processor work into the Base-model lanes.

## V0.2.24 cumulative Base vLLM response byte progress

V0.2.24 shows how many raw response bytes the Proxy has actually received from the **Base vLLM response body** while a managed Claude Code request is still running. This is intended to distinguish a genuinely idle/stalled model from a model that is still returning data slowly.

The count is cumulative for the current managed request and is measured at the Base-vLLM HTTP response-body boundary before JSON or SSE decoding. It does **not** count request bytes, Proxy-to-Claude-Code SSE bytes, SearXNG bytes, WebFetch Processor bytes, or visual-model bytes.

Display uses binary units with automatic scaling: `B / KB / MB / GB`.

Example with `MODEL_RESPONSE_LANGUAGE=zh-TW`:

```text
目前處理進度（已收到 20 B）：
主模型仍在處理本輪請求，已等待 30 秒（已收到 1.22 KB）…
主模型仍在處理本輪請求，已等待 60 秒（已收到 1.12 MB）…
主模型已完成本輪回答；正在回傳結果…
```

The same received-byte value is localized through the existing five response-language profiles (`zh-TW`, `zh-CN`, `en-US`, `ja-JP`, `ko-KP`). No new ENV variable is required; the existing `PROGRESS_HEARTBEAT_MS` cadence still controls heartbeat timing.

For native Server Tool flows, the progress text block still closes when the server-tool lifecycle begins. V0.2.24 does not change that Claude Code SSE/tool boundary merely to keep heartbeat text open.

## V0.2.23.2 native WebSearch forced-choice hotfix

V0.2.23.2 fixes an intermittent Claude Code native WebSearch child failure where the child request declared only `web_search`, but the Base model could still return ordinary text with `stop_reason=end_turn`. Claude Code then displayed `Did 0 searches`, and the main agent could incorrectly infer that network access was unavailable.

For an **exclusive native WebSearch child request** (`web_search_YYYYMMDD` only), normalization now sends the Base model exactly one managed tool and forces that tool for the first model round:

```json
{
  "tools": [{ "name": "web_search", "input_schema": "..." }],
  "tool_choice": { "type": "tool", "name": "web_search" }
}
```

After that forced `web_search` call completes and SearXNG returns its tool result, the hidden managed continuation changes `tool_choice` to `{ "type": "auto" }` before the next Base-model round. This lets the model summarize the search evidence instead of being forced to search repeatedly.

The forced-choice rule is intentionally narrow:

- Exclusive native `web_search_YYYYMMDD` child -> single normalized `web_search` + forced tool choice.
- Native WebFetch child -> unchanged.
- Mixed native Search plus any other tool -> unchanged; no forced choice is injected.
- Main-agent ordinary `WebSearch` / `WebFetch` handoff -> unchanged and still owned by Claude Code.

Operational diagnostics add `forced_tool_choice=true` to `native_web_tools_normalized` for this path and emit `managed_forced_tool_choice_satisfied` when the first forced Search call has completed and the continuation is released to `auto`.

The external release label is `0.2.23.2`; npm-valid package metadata is `0.2.23+hotfix.2`.

## V0.2.23.1 response-language boundary hotfix

V0.2.23.1 keeps the same `MODEL_RESPONSE_LANGUAGE` setting and the same five locale profiles introduced by V0.2.23. The external release label is `0.2.23.1`; npm-valid package metadata is `0.2.23+hotfix.1`.

The hotfix changes only the Main/Base-model language instruction. V0.2.23 used a soft preference and appended an Anthropic `system` text block without a guaranteed separator. Some vLLM Anthropic adapters concatenate system text blocks directly, so the policy could become adjacent to the preceding Claude Code text.

V0.2.23.1 uses a direct instruction:

```text
Respond in Traditional Chinese (zh-TW).
```

The complete locale mapping is:

```text
zh-TW: Respond in Traditional Chinese (zh-TW).
zh-CN: Respond in Simplified Chinese (zh-CN).
en-US: Respond in English (en-US).
ja-JP: Respond in Japanese (ja-JP).
ko-KP: Respond in Korean (ko-KP).
```

When the incoming Anthropic `system` value is an array, the Proxy prefixes the appended language block with the literal boundary `\n\n`. Therefore a direct block join still produces a clear policy boundary:

```text
<existing Claude Code system text>\n\nRespond in Traditional Chinese (zh-TW).
```

For string-form systems, the Proxy likewise inserts one blank-line boundary before the language instruction. Requests without an existing system receive only the instruction itself.

The WebFetch Processor instruction, locale/status registry, English fallback, WebSearch/WebFetch lifecycle, media adaptation, and diagnostic behavior are unchanged from V0.2.23.

## V0.2.23 response language localization

V0.2.23 adds one runtime setting for the default language used by user-visible model responses and Proxy-generated status text:

```env
MODEL_RESPONSE_LANGUAGE=zh-TW
```

Supported values are:

```text
zh-TW  Traditional Chinese
zh-CN  Simplified Chinese
en-US  English
ja-JP  Japanese
ko-KP  Korean (ko-KP locale)
```

A missing, blank, or unsupported value resolves to `en-US`. No second language-mode ENV is required.

The resolved locale controls three output surfaces:

1. **Main/Base model** — the Proxy appends one short system instruction immediately before the request is sent upstream.
2. **WebFetch Processor** — the independent processor receives a short locale-specific output instruction.
3. **Proxy progress/status** — Search, Fetch, queue, media/PDF/image, heartbeat, recovery, handoff, and final-return status text uses the same locale.

V0.2.23 originally used the following softer main-model instruction; V0.2.23.1 supersedes it with the hard instruction documented above:

```text
Default to Traditional Chinese (zh-TW) for user-visible responses. Preserve technical literals verbatim.
```

The Processor instruction is shorter still:

```text
Write the result in Traditional Chinese (zh-TW).
```

Technical literals such as code, commands, paths, filenames, identifiers, URLs, hostnames, API/tool names, and tool arguments are preserved verbatim when appropriate. Dynamic literals embedded inside Proxy progress/status messages are likewise not translated.

Because the policy is injected at the Proxy boundary, it does not depend on `CLAUDE.md` being present in every Claude Code child request. `/v1/messages/count_tokens` receives the same main-model policy so token accounting matches the transformed model request. Claude Code WebFetch 200-content processor children receive the Processor-specific instruction instead of being sent through the main Laguna model.

Example locale behavior:

```text
zh-TW: 目前處理進度： / 正在搜尋：<query>…
zh-CN: 当前处理进度： / 正在搜索：<query>…
en-US: Current progress: / Searching: <query>…
ja-JP: 現在の処理状況： / 検索中：<query>…
ko-KP: 현재 처리 상태: / 검색 중: <query>…
```

## V0.2.22 Claude Code-owned Web lifecycle

V0.2.22 replaces the V0.2.20/V0.2.21 assumption that ordinary main-agent Web tools should be converted immediately into synthetic Anthropic server tools.

The runtime now distinguishes two protocol layers.

### Main-agent ordinary tools

The main-agent boundary treats ordinary `WebSearch` / `WebFetch` as Claude Code-owned client tools.

Exact built-in aliases are handed back to Claude Code as ordinary client tools:

```text
WebSearch / web_search
WebFetch  / web_fetch
```

When the Base model emits one of these ordinary tool calls, the Proxy does **not** execute SearXNG or awesome-web-fetch inside the same main `/v1/messages` request. It returns the original `tool_use` to Claude Code so the terminal can keep its native tool row and lifecycle.

```text
Laguna
  -> tool_use(WebSearch / WebFetch)
  -> Proxy handoff
  -> Claude Code built-in renderer/executor
```

The diagnostic event for this boundary is:

```text
server_web_ui_bridge_selected mode=claude_code_client_tool
client_web_tool_handoff
```

Mixed ordinary tools are preserved in the same response. For example, `WebSearch + Read` is returned as two client `tool_use` blocks; the Proxy does not convert one into a server tool or silently delay the other.

### WebSearch child requests

Claude Code's built-in WebSearch creates a second `/v1/messages` child request containing a dated native tool declaration such as:

```text
web_search_YYYYMMDD
```

That child request remains Proxy-managed. The native definition is normalized only for the local Base-model protocol, SearXNG performs the actual search, and the Anthropic-compatible server-tool result is returned to Claude Code. Overall research depth is therefore controlled by Claude Code's normal multi-turn lifecycle instead of being trapped inside one `MAX_TOOL_ROUNDS` loop.

```text
Main agent WebSearch
  -> Claude Code native Web Search UI
  -> native web_search_YYYYMMDD child request
  -> Proxy / SearXNG
  -> web_search_tool_result
  -> Claude Code returns tool_result to the main agent
```

`MAX_TOOL_ROUNDS` now acts only as a safety fuse for one Proxy-managed child workflow; it is not the intended limit on how many research steps the agent may perform across Claude Code turns.

### WebFetch 200-content processor child

Claude Code's built-in WebFetch directly downloads normal HTTP 200 content. It then creates a content-processing `/v1/messages` child request with no tools and a payload beginning with:

```text
Web page content:
---
...
---
```

V0.2.22 detects this exact Claude Code child shape and routes it directly to `WEB_FETCH_PROCESSOR_URL` instead of sending the large page back through the main Laguna model. The configured `WEB_FETCH_PROCESSOR_PROVIDER=vllm|ollama`, model, API key, THINK mode, timeout and global concurrency limit remain in force.

```text
Main agent WebFetch
  -> Claude Code native Fetch UI
  -> Claude Code downloads page
  -> Web page content: child request
  -> Proxy WebFetch Processor
  -> child text response
  -> Claude Code returns tool_result to the main agent
```

This avoids a second full Base-model reasoning pass for the common 200-OK WebFetch path.

### Redirect/error awesome-web-fetch fallback

Claude Code may return a redirect or explicit fetch error without creating the 200-content processor child. V0.2.22 detects only those failure-shaped `tool_result` blocks. Using the original `tool_use_id`, it finds the corresponding WebFetch URL/prompt, invokes awesome-web-fetch, applies the normal WebFetch Processor, and replaces only the **Base-model view** of that tool result.

Claude Code's transcript remains unchanged; the model receives the enriched result and therefore does not need to issue a second WebFetch merely to follow a redirect.

```text
Claude Code Fetch
  -> 302 / explicit fetch error
  -> tool_result returns to Proxy
  -> awesome-web-fetch fallback
  -> WebFetch Processor
  -> enriched tool_result sent only to Laguna
```

Successful Claude Code WebFetch summaries are never re-fetched. Enrichment is cached by session/tool-use identity so replayed history does not repeat the fallback download.

### Matching boundaries

The Proxy continues to use exact aliases and dated native forms. It does not capture arbitrary substring or MCP tool names:

```text
captured/recognized:
  WebSearch
  web_search
  web_search_YYYYMMDD
  WebFetch
  web_fetch
  web_fetch_YYYYMMDD

not captured by substring:
  mcp__searxng__web_search
  company_web_search_v2
  my_web_fetch
```

Diagnostic file tracing from `0.2.21-diagnostic.1` remains available but is disabled by default.

## V0.2.22 architecture

```text
Claude Code
  -> vllm-cc-tools-proxy:8080
       ├─ ordinary WebSearch/WebFetch: hand back to Claude Code
       ├─ native web_search child: SearXNG
       ├─ WebFetch 200-content child: WebFetch Processor
       ├─ WebFetch redirect/error: awesome-web-fetch fallback + Processor
       ├─ local Poppler/ImageMagick: PDF/image adaptation
       ├─ visual provider: vLLM or Ollama
       └─ base vLLM: main reasoning and Claude Code tool calling
```

Routing remains transparent for ordinary traffic, while PDF/image workflows and native Web child workflows stay bounded and observable. The deployment remains one official `node:22-bookworm-slim` service with persistent source/cache/data volumes and no Redis, parser sidecars or custom Docker image.

## Historical V0.2.21 Native Claude Code Web Tool UI Bridge

V0.2.21 keeps the V0.2.20 Proxy-owned Server Tool execution model, but tightens the Claude Code-facing streaming contract so WebSearch/WebFetch can be rendered as native tool activity instead of disappearing while the Proxy works.

For streaming requests the Proxy now detects explicit built-in declarations using only exact aliases or dated Anthropic forms:

```text
WebSearch / web_search / web_search_YYYYMMDD
WebFetch  / web_fetch  / web_fetch_YYYYMMDD
```

Substring/MCP/custom names remain excluded. When an eligible declaration is present, diagnostics report:

```text
server_web_ui_bridge_selected
mode=native_server_tool
```

If no eligible declaration exists, the Proxy uses the existing `visible_progress` path instead of pretending an unrelated tool is native.

The live `server_tool_use` SSE start event now matches the Anthropic streaming shape and includes the required empty input object before `input_json_delta` streams the actual arguments:

```json
{"type":"server_tool_use","id":"srvtoolu_...","name":"web_search","input":{}}
```

Search result blocks also carry response-side metadata expected by Anthropic-compatible clients. Every synthetic `web_search_result` includes `title`, `url`, `page_age` (nullable), and an opaque `encrypted_content` token. The token is a Proxy-local identity marker only; the Proxy never claims it is Anthropic-encrypted source text and later turns convert completed server-web history into bounded local evidence before it reaches the Base model.

WebFetch result blocks likewise always provide a document title and `retrieved_at` timestamp. Existing SearXNG execution, awesome-web-fetch, Ollama/vLLM WebFetch Processor routing, usage counters, mixed server + client continuation, and three-slot Processor concurrency are unchanged.

The intended Claude Code presentation is the native tool row, for example:

```text
● Web Search("...")
● Web Fetch("...")
```

The Proxy still owns execution; Claude Code should not execute the same WebSearch/WebFetch a second time.

## Historical V0.2.20 unified Web Server Tool Bridge

V0.2.20 changes Proxy-owned WebSearch and WebFetch from hidden/internal client-tool handling into an Anthropic-compatible server-tool lifecycle. The model still chooses the web action, Claude Code can see that the action exists, but the Proxy owns execution and Claude Code does not execute the web tool a second time.

Explicit aliases are canonicalized before dispatch:

```text
WebSearch
web_search
web_search_YYYYMMDD
    -> canonical web_search

WebFetch
web_fetch
web_fetch_YYYYMMDD
    -> canonical web_fetch
```

The dated form requires exactly eight decimal digits. Third-party/client tools are intentionally not captured by substring matching; names such as `mcp__searxng__web_search`, `company_web_search_v2`, `my_web_fetch` remain Claude Code/MCP tools.

For a pure Proxy-owned web action the external lifecycle is:

```text
model chooses web_search / web_fetch
  -> server_tool_use streamed or returned to Claude Code
  -> Proxy executes SearXNG / awesome-web-fetch (+ optional WebFetch Processor)
  -> web_search_tool_result / web_fetch_tool_result
  -> Base model continues with the verified result
  -> final text/tool decision
```

Streaming responses expose the server-tool block before execution and the result block when it is ready. Final Anthropic usage carries `server_tool_use.web_search_requests` and/or `server_tool_use.web_fetch_requests`, so the frontend does not see a Proxy-owned search as an uncounted client-side WebSearch.

### Mixed server + client tools

When one model response contains a Proxy-owned web action together with a Claude Code tool such as Read, Write or Bash, V0.2.20 preserves both intentions instead of executing one and dropping/reissuing the other:

```text
model: WebSearch + Read
  -> Proxy returns server_tool_use(web_search) + tool_use(Read)
  -> WebSearch remains deferred; SearXNG has not run yet
  -> Claude Code executes Read and sends its tool_result
  -> Proxy reconstructs the unresolved server_tool_use from request history
  -> Proxy executes WebSearch
  -> web_search_tool_result is emitted first in the continuation
  -> Base model receives both correlated results and continues
```

No Redis or hidden session store is required for this continuation; the unresolved server-tool state is reconstructed from the Claude Code message history. Completed `server_tool_use + web_*_tool_result` history is converted into bounded model-readable evidence before later Base-model turns, while unresolved server uses remain intact until their client-tool dependency returns.

The same bridge handles WebFetch. Existing `WEB_FETCH_PROCESSOR_PROVIDER=vllm|ollama`, independent Processor URL/API key/model, maximum three Processor slots, Processor timeout, deterministic final promotion and managed-loop stability gates remain unchanged.

## V0.2.19.2 deterministic final promotion and tool-description isolation

## V0.2.19.3 WebFetch Processor provider routing

V0.2.19.3 adds explicit `WEB_FETCH_PROCESSOR_PROVIDER=vllm|ollama` routing while keeping the OpenAI-compatible `/v1/chat/completions` wire format. Root/base Processor URLs are expanded automatically, so `http://192.168.10.169:11434` becomes `http://192.168.10.169:11434/v1/chat/completions`. Complete endpoints and existing custom non-root paths are preserved.

For `vllm`, thinking control uses `chat_template_kwargs.enable_thinking`. For `ollama`, the OpenAI-compatible request uses `reasoning_effort=none` when `WEB_FETCH_PROCESSOR_THINK=false` and `reasoning_effort=high` when true. URL, API key, model, 3-slot concurrency and timeout remain independently configurable.

V0.2.19.2 adds a strict fast path for Laguna/Poolside responses where the model has already completed the user answer but `poolside_v1` returns it only as a `thinking` block. If the response is `end_turn`, thinking-only, has no tool calls, no active protocol tags, has answer-like structure, and contains no continuation intent, the proxy promotes that text directly into one visible Anthropic `text` block. No second Base-model recovery call is made. Unsafe cases keep the existing final-channel or continuation recovery path.

Claude Code tool documentation can itself contain literal protocol examples such as `<thinking>...</thinking>` and `<tool_call>`. Before tool definitions reach the Base vLLM, V0.2.19.2 recursively neutralizes active control tags only in fields named `description`, including nested JSON-schema descriptions. Tool names, enums, defaults, schema values and ordinary user text are preserved exactly.

New content-free diagnostics are `managed_final_response_promoted` and `protocol_tool_descriptions_sanitized`; `incoming_protocol_inventory` also reports tool-definition tag counts.

## V0.2.19.1 parallel WebFetch and slow-model budgets

V0.2.19.1 is a stability hotfix for local models that are correct but slow. It keeps the V0.2.19 protocol validation/recovery gates and changes managed research scheduling rather than simply shortening timeouts.

### Parallel WebFetch Processor

Independent managed tool calls from the same model round execute concurrently and preserve tool-result order. WebFetch Processor inference is protected by one proxy-wide semaphore, so the total number of Processor model requests across all Claude Code sessions never exceeds:

```env
WEB_FETCH_PROCESSOR_CONCURRENCY=3
```

The value is strictly bounded to `1..3` and defaults to `3`. A fourth Processor request waits for a global slot. Web page downloads may overlap; the semaphore is acquired only for the Processor model request.

Processor routing remains independently configurable:

```env
WEB_FETCH_PROCESSOR_PROVIDER=vllm
WEB_FETCH_PROCESSOR_URL=
WEB_FETCH_PROCESSOR_API_KEY=
WEB_FETCH_PROCESSOR_MODEL=
WEB_FETCH_PROCESSOR_THINK=false
WEB_FETCH_PROCESSOR_CONCURRENCY=3
WEB_FETCH_PROCESSOR_TIMEOUT_MS=300000
WEB_FETCH_PROCESSOR_TIMEOUT_MS=300000
```

`WEB_FETCH_PROCESSOR_PROVIDER` accepts `vllm` or `ollama` and defaults to `vllm`. A Processor base URL such as `http://192.168.10.169:11434` is normalized to `/v1/chat/completions`; an already complete `/v1/chat/completions` endpoint is preserved. A blank Processor URL derives `/v1/chat/completions` from `VLLM_BASE_URL`. A blank Processor MODEL uses the current Base request model. `VLLM_BASE_API_KEY` is inherited only when the Processor URL is also derived from Base; an explicitly configured Processor URL requires its own `WEB_FETCH_PROCESSOR_API_KEY` when authentication is needed.

### Activity-aware managed timeouts

The default Base-model first-byte deadline is:

```env
MANAGED_MODEL_ROUND_TIMEOUT_MS=360000
```

For streaming-capable managed Base requests, this value bounds time to the first upstream response byte rather than total generation wall time. After first byte, a 90-second sliding inactivity window controls liveness and is refreshed by every new upstream response chunk.

There is no whole-task deadline by default. `MANAGED_TASK_TIMEOUT_MS` is an optional compatibility override and is intentionally omitted from `.env.example`; unset, blank, or `0` means disabled. If explicitly set to a positive bounded value, it again acts as an absolute deadline across managed model/tool work and may trigger final-round reservation near exhaustion. Loop protection remains independent through `MAX_TOOL_ROUNDS`, repeated-action detection, protocol validation, and recovery. When that optional deadline is enabled and the remaining budget falls to one model-round budget or less, the existing `managed_final_round_reserved` behavior may reserve the final Base round by removing only managed research tools.

### WebSearch argument normalization

Some local models emit a single domain as a string even when Claude Code's WebSearch schema requires an array. Before proxy execution or mixed-tool handoff, V0.2.19.1 normalizes:

```text
allowed_domains: "docs.openssl.org" -> ["docs.openssl.org"]
blocked_domains: "example.com"      -> ["example.com"]
```

Existing arrays are preserved. This prevents an otherwise valid WebSearch action from failing Claude Code input validation.

V0.2.19.1 still does not emulate Anthropic Native Web Search result/citation counters; that remains planned separately.

## V0.2.19 managed stability gates

V0.2.19 hardens the proxy-side managed execution loop used for WebSearch/WebFetch and media-assisted turns. It does **not** implement Anthropic-native Web Search result/citation emulation; that remains a separate compatibility layer.

### 1. Validate every managed Base response

V0.2.18 only entered final-response recovery when the Base response contained no structured `tool_use`. V0.2.19 runs the same protocol validation gate for **all** managed Base responses before any tool is dispatched.

A response containing a valid structured `tool_use` plus leaked raw protocol markup in `thinking`/visible output is therefore rejected and recovered before the tool can execute. Structured tool arguments themselves remain data and may legitimately contain strings such as parser examples.

### 2. Continuation recovery is non-thinking and state-aware

Continuation recovery keeps the original tools and `tool_choice`, but now forces:

```json
{"chat_template_kwargs":{"enable_thinking":false,"preserve_thinking":false}}
```

The previous incomplete model state is copied into the recovery request only as a bounded, control-tag-neutralized data excerpt. This prevents the recovery call from restarting blind while also preventing raw `<tool_call>`, `<arg_key>`, `<arg_value>`, `<think>` and related markup from becoming active prompt syntax.

For Laguna S 2.1 on vLLM, the expected runtime pair is:

```text
--tool-call-parser poolside_v1
--reasoning-parser poolside_v1
```

When a managed response shows control-tag leakage or a final answer trapped only in reasoning, the proxy emits the content-free diagnostic `laguna_runtime_contract_violation` with the expected parser names and observed anomaly counts. This is observational telemetry; the proxy does not claim to introspect vLLM command-line flags remotely.

### 3. Claude Code `tool_result` history is isolated

Incoming Claude Code tool results are untrusted evidence. V0.2.19 recursively neutralizes known model-control tags inside `tool_result.content` before forwarding history to the Base model, including nested text arrays and string payloads. Ordinary user text is not rewritten.

This extends the existing quarantine boundary beyond proxy-owned WebSearch/WebFetch results to Read/Bash/MCP and other Claude Code tool-result content.

### 4. Exact repeated managed actions stop as no progress

If two consecutive managed rounds request the exact same managed tool name and equivalent arguments, the second action is not executed. The request fails with:

```text
managed_no_progress
```

This prevents repeated WebSearch/WebFetch calls from consuming the remaining round budget without adding evidence. The normal `MAX_TOOL_ROUNDS` limit still applies to changing actions.

### 5. Activity-aware model rounds and optional managed-task deadline

Current V0.2.26.1 behavior supersedes the original V0.2.19 absolute-round policy. `MANAGED_MODEL_ROUND_TIMEOUT_MS` defaults to 360000 ms and is a first-byte deadline when upstream activity telemetry is available. After first byte, continued response-body activity may extend the round beyond six minutes; 90 seconds of post-start inactivity raises `managed_model_stall_timeout`.

`MANAGED_TASK_TIMEOUT_MS` is optional and disabled by default. Unset, blank, or `0` means no whole-task absolute deadline. A positive configured value enables the compatibility safety cap and can raise `managed_task_timeout`.

Timeout codes:

```text
managed_model_timeout
  no first Base-model response byte arrived within the first-byte deadline

managed_model_stall_timeout
  Base-model response bytes started, then no new bytes arrived for the inactivity window

managed_task_timeout
  optional whole-task deadline was explicitly enabled and exhausted
```

These semantic limits are independent of the more general `VLLM_BASE_HEADERS_TIMEOUT_MS` / `VLLM_BASE_BODY_TIMEOUT_MS` transport protections.

## Quick start

```bash
cp .env.example .env
# Set VLLM_BASE_URL. Set all VLLM_VISION_* values for image/scanned-PDF support.
docker compose up -d
```

Point Claude Code at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=local-vllm
claude
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Persistent volumes

```text
proxy-source
  Git checkout
  node_modules
  dependency fingerprint

proxy-npm-cache
  npm package download cache

proxy-apt-cache
  downloaded Debian package archives

proxy-data
  normalized PDF/image analysis cache
  atomic cache entries and runtime cache metadata
```

Normal update:

```bash
docker compose restart vllm-cc-tools-proxy
```

The restart runs `git pull --ff-only`. When `package-lock.json` has not changed, npm installation is skipped. To discard all persisted source and package state explicitly:

```bash
docker compose down -v
```

This deletion is destructive and forces a new clone and dependency installation on the next start.
It also deletes the persistent media-analysis cache.

## Required vLLM settings

```env
VLLM_BASE_URL=http://host.docker.internal:8000
VLLM_BASE_API_KEY=
VLLM_BASE_CONNECT_TIMEOUT_MS=10000
VLLM_BASE_HEADERS_TIMEOUT_MS=900000
VLLM_BASE_BODY_TIMEOUT_MS=900000

VLLM_VISION_URL=http://host.docker.internal:8001
VLLM_VISION_MODEL=Qwen/Qwen3.6-27B
VLLM_VISION_API_KEY=
VLLM_VISION_PROVIDER=vllm
VLLM_VISION_THINK=false
VLLM_VISION_TIMEOUT_MS=120000
```

`VLLM_BASE_URL` points to an Anthropic Messages-compatible vLLM endpoint. The proxy sends the base key only to this endpoint. The proxy uses explicit upstream timeouts instead of Node.js fetch defaults:

```text
VLLM_BASE_CONNECT_TIMEOUT_MS
  TCP/TLS connection establishment

VLLM_BASE_HEADERS_TIMEOUT_MS
  wait for Base vLLM HTTP response headers

VLLM_BASE_BODY_TIMEOUT_MS
  maximum idle interval between response-body chunks
```

The defaults are 10 seconds, 15 minutes and 15 minutes respectively. Timeout failures are classified as `vllm_connect_timeout`, `vllm_headers_timeout` or `vllm_body_timeout`; connection refusal, reset and network-unreachable failures retain separate error codes.

`VLLM_VISION_URL` and `VLLM_VISION_MODEL` must be configured together. `VLLM_VISION_PROVIDER` is either `vllm` or `ollama` and defaults to `vllm` for backward compatibility.

Provider behavior:

```text
VLLM_VISION_PROVIDER=vllm
  -> POST /v1/chat/completions
  -> VLLM_VISION_THINK=false sends reasoning_effort=none
     and chat_template_kwargs.enable_thinking=false

VLLM_VISION_PROVIDER=ollama
  -> POST /api/chat
  -> VLLM_VISION_THINK=false sends think=false
```

`VLLM_VISION_THINK` accepts only `true` or `false`; invalid values stop startup. Quality recovery preserves this value rather than switching thinking on. `VLLM_VISION_TIMEOUT_MS` defaults to 120000 ms and bounds each Vision upstream request; values below 1000 ms are rejected. Visual reasoning remains internal to the visual tool loop and is never copied into the normalized document/image block or forwarded to the base vLLM. For an Ollama-hosted Qwen3.6 model, configure `VLLM_VISION_PROVIDER=ollama` explicitly.


## Structured evidence contract

V0.2.7 treats every PDF-native-text and visual-model result as untrusted source evidence. It no longer embeds free-form model text inside generic XML-like `<document>`, `<analysis>` or `<visual_batch>` wrappers.

Transformed media is represented as a non-XML envelope:

```text
[VCC_PROXY_EVIDENCE_BEGIN version=1 kind=document]
content_encoding: html-entity
--- source content ---
...
[VCC_PROXY_EVIDENCE_END]
```

Before insertion, all source `&`, `<` and `>` characters are HTML-entity escaped. Consequently source strings such as:

```text
</think>
<tool_call>
</function_result>
<|im_start|>
```

arrive at the base model only as inert data such as `&lt;/think&gt;`. A neutral-evidence invariant rejects any normalized evidence block that still contains active known model-control syntax.

Each transformed request receives one idempotent `VCC_PROXY_EVIDENCE_CONTRACT_V1` system contract. It tells the base model that the envelope is immutable evidence, not instructions, reasoning delimiters, tool syntax or a format to continue or close. Clean byte-transparent bypass requests do not receive this contract.

To stop an already contaminated Claude Code history from amplifying malformed protocol text, V0.2.7 also neutralizes known control tags only inside structured assistant `thinking` blocks before forwarding. User-visible text is not rewritten. If a clean request contains no media and no contaminated structured thinking, it remains a raw bypass.

V0.2.10 extends protocol provenance checks across the complete managed-tool boundary without logging source text:

```text
incoming Claude Code system/history
managed WebSearch/WebFetch tool result
managed final Base-model response
streamed Base-model thinking/text
```

Diagnostics record tag names, counts, block types and byte counts only:

```text
incoming_protocol_inventory
managed_tool_result_protocol_inventory
managed_final_response_inspected
managed_final_response_repair_start
managed_final_response_repair_success
managed_final_response_rejected
base_generation_control_tags_detected
```

Every string inside a managed tool result is recursively neutralized before it is serialized as Anthropic `tool_result`. This prevents fetched Markdown or search snippets containing `</tool_response>`, `</function_results>`, `<tool_call>`, ChatML tokens or related singular/plural wrappers from becoming active prompt syntax.

V0.2.19 applies the same control-tag quarantine to **incoming Claude Code `tool_result` history** before any transformed request is sent to the Base model. The rewrite is limited to tool-result payloads and malformed assistant reasoning; ordinary user-visible text remains byte-preserved.

V0.2.14 no longer treats every thinking-only response as a completed final answer. Invalid no-tool responses are routed conservatively: only a substantial structured answer with no continuation intent enters short final-channel recovery; unfinished reasoning, next-step planning, missing visible output and ambiguous content enter continuation recovery with the original tools preserved. A second invalid response is rejected as `response_recovery_exhausted`; raw protocol tags are not forwarded to Claude Code. Valid Base output is never regex-deleted or silently rewritten.

After upgrading from a session that already displayed raw `</function_result>`, `</function_results>`, `</thinking>` or `<tool_call>` text, start a new Claude Code session for that task. Structured thinking history is sanitized on later requests, but intentionally does not rewrite already-visible assistant text.





## V0.2.18 response-side native web containment

V0.2.17 normalized Anthropic native Web Search/Web Fetch definitions on the request path. V0.2.18 completes the reverse path so Base-model native server-tool blocks cannot escape into Claude Code's native Web Search UI.

For every buffered managed Base response, the proxy now applies this containment before final-response inspection or recovery:

```text
server_tool_use:name=web_search
  -> internal tool_use:name=web_search
  -> execute SearXNG locally
  -> correlated local tool_result
  -> next Base-model round

server_tool_use:name=web_fetch
  -> internal tool_use:name=web_fetch
  -> execute awesome-web-fetch locally
  -> correlated local tool_result
  -> next Base-model round

web_search_tool_result / web_fetch_tool_result
  -> removed from the Base response
  -> never forwarded to Claude Code
```

The normalized assistant history contains only the internal `tool_use` blocks actually executed by the proxy. Native result blocks supplied by the Base endpoint are discarded because they do not represent the local SearXNG or awesome-web-fetch execution result.

If one Base response contains a response-side Native Web call together with a Claude Code tool such as `Read`, `Write`, `Edit`, `Bash` or `Task`, the proxy executes the Native Web call first and defers the unrelated tool block. The next Base round receives the real web evidence and may emit the Claude Code tool again. This avoids returning a `web_search` block to Claude Code merely because the model attempted parallel tool calls. The safe diagnostic event is:

```text
native_web_mixed_tool_deferred
```

Every contained response emits a content-free diagnostic summary:

```text
native_web_response_contained
```

It records only the managed round, Native Server Tool count, removed Native Result count and original block-type names. It does not log query text, URLs, fetched content or credentials.

The final Anthropic SSE emitter and non-stream response path apply an additional containment filter. The following block types are therefore forbidden in the response returned to Claude Code:

```text
server_tool_use:web_search
server_tool_use:web_fetch
web_search_tool_result
web_fetch_tool_result
```

Consequently Claude Code should not render the native status line `Did 0 searches`. Search/fetch progress remains the proxy's own readable progress text, and the final user-visible response contains only normal text, thinking or Claude Code tool blocks.

## V0.2.17 native web tool normalization

Claude Code may send Anthropic server-tool definitions instead of ordinary custom tools:

```json
{"type":"web_search_20250305","name":"web_search","max_uses":8}
{"type":"web_fetch_20250910","name":"web_fetch","max_uses":5}
```

These definitions intentionally have no `input_schema`, because Anthropic executes them as server tools. A local vLLM Anthropic-compatible endpoint commonly validates every tool as a custom tool and rejects the request before model generation.

V0.2.17 detects any dated `web_search_*` or `web_fetch_*` type, extracts its local policy, and sends a vLLM-compatible custom definition to both:

```text
/v1/messages/count_tokens
/v1/messages
```

The normalized definitions contain:

```text
web_search → required query string
web_fetch  → required URL plus optional prompt
```

Native-only fields such as `type`, `max_uses`, `allowed_domains`, `blocked_domains`, `user_location`, `citations`, and `max_content_tokens` are never forwarded to vLLM. The proxy applies the supported local policies instead:

- `max_uses` counts every attempted managed invocation, including failed fetch/search attempts.
- `allowed_domains` and `blocked_domains` filter WebSearch results and validate WebFetch targets.
- Domain rules include subdomains; WebSearch rules may also include a path prefix.
- `max_content_tokens` becomes a conservative four-characters-per-token WebFetch output ceiling, further bounded by the configured resource profile.
- `citations` and `user_location` are retained as request metadata but are not emulated as Anthropic-native citations or localized search controls.
- Newer dynamic-filtering and `allowed_callers` fields are removed from the vLLM request and counted as unsupported policy metadata in diagnostics.

Existing custom `WebSearch`, `web_search`, `WebFetch`, `web_fetch`, and all non-web tools remain unchanged. If a native and custom alias coexist, the existing custom definition is retained and the native policy still applies locally.

A successful normalization emits only metadata:

```text
native_web_tools_normalized
```

The event records tool counts and policy presence, not domains, URLs, prompts, search results, fetched content, or credentials.

## V0.2.16 Anthropic usage preservation

Claude Code uses Anthropic `usage` metadata to estimate the current context and decide when automatic compaction should run. Earlier managed streams opened a synthetic Anthropic `message_start` immediately for progress reporting but set:

```json
{"usage":{"input_tokens":0,"output_tokens":0}}
```

Because Anthropic input usage belongs to the first `message_start`, a later Base-model response could not legally repair that value. V0.2.16 performs one lightweight token preflight before opening a streamed managed response:

```text
POST /v1/messages/count_tokens
  -> input_tokens
  -> synthetic message_start.usage.input_tokens
  -> normal managed model/tool workflow
```

The downstream initial usage preserves the Anthropic-compatible fields when supplied:

```text
input_tokens
cache_creation_input_tokens
cache_read_input_tokens
output_tokens
server_tool_use
```

For local vLLM deployments without Anthropic prompt caching, the cache fields remain zero. The final `message_delta` continues to carry the real `output_tokens` from the Base-model response.

Direct transformed streaming still emits exactly one downstream `message_start`. The proxy observes the upstream `message_start` and `message_delta` usage for diagnostics, compares the upstream input count with the preflight count, and forwards the upstream content events with their original indexes shifted only when a visible progress block exists.

Safe token-only diagnostics:

```text
managed_usage_preflight_succeeded
  input_tokens=...
  cache_creation_input_tokens=...
  cache_read_input_tokens=...
  total_input_tokens=...

managed_usage_preflight_failed
  code=...
  retryable=...

managed_response_usage_observed
managed_stream_usage_observed
  preflight_input_tokens=...
  upstream_input_tokens=...
  input_token_delta=...
  output_tokens=...
```

A missing or unsupported `/v1/messages/count_tokens` endpoint does not terminate the Claude Code turn. The proxy logs `managed_usage_preflight_failed`, emits a zero-valued fallback usage object, and continues the original model/tool workflow. For reliable Claude Code automatic compaction, the Base vLLM endpoint should implement the token-count route.

For a 224,000-token local context with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=16384`, a 200,000-token compact threshold leaves only 7,616 tokens for one large tool result before the next request can overflow. The recommended operational value is:

```bash
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000
```

This leaves approximately 27,616 tokens of headroom for the requested output and a large Read/Bash/WebFetch result. V0.2.16 does not modify Claude Code history or invoke compaction itself; it restores the usage signal Claude Code needs to make that decision.

No additional ENV setting is introduced.

## V0.2.15 proxy-turn progress semantics

Progress text describes the current proxy/model turn. It does not claim that the complete Claude Code task has finished.

Buffered managed responses are classified before the progress block closes:

```text
response contains one non-managed tool call
  -> 主模型已產生下一步 Write；正在交還 Claude Code 執行…
  -> phase: handoff_to_claude_code

response contains multiple non-managed tool calls
  -> 主模型已產生下一步工具；正在交還 Claude Code 執行…
  -> phase: handoff_to_claude_code

response contains visible text and no tool call
  -> 主模型已完成本輪回答；正在回傳結果…
  -> phase: returning_visible_response

other valid model output
  -> 主模型已完成本輪輸出；正在回傳結果…
  -> phase: returning_model_output
```

Structured state distinguishes the two completion scopes:

```text
terminal_for_proxy=true
  the current proxy API turn can be returned

terminal_for_claude_task=false
  the proxy does not claim Claude Code's outer task is finished
```

For direct upstream streaming, the first model content block closes visible progress with a non-terminal streaming phase:

```text
text      -> streaming_visible_response
thinking  -> streaming_thinking
tool_use  -> streaming_tool_action
other     -> streaming_model_output
```

Generic semantic heartbeats use:

```text
主模型仍在處理本輪請求，已等待 30 秒…
```

File-aware heartbeats retain the safe filename while using the same current-turn wording. V0.2.15 changes only progress copy and structured progress phases; V0.2.14 Tool Routing and Recovery Routing remain unchanged.


## V0.2.14 recovery routing

The proxy remains subordinate to Claude Code's outer agent loop. It executes only proxy-owned WebSearch/WebFetch calls and must not decide that the complete Claude Code task is finished merely because one Base-model turn ended in `thinking`.

The no-tool recovery state machine is:

```text
invalid no-tool Base response
  ├─ completed structured answer, no continuation intent
  │    -> Final-channel recovery
  │    -> short context only
  │    -> chat_template_kwargs.enable_thinking=false
  │    -> tools and tool_choice removed
  │    -> visible final text only
  │
  └─ unfinished, planning, missing or ambiguous output
       -> Continuation recovery
       -> original conversation and evidence retained
       -> preserves the original tools and tool choice
       -> model must emit one valid next action
```

Continuation recovery may return:

```text
managed WebSearch/WebFetch tool call
  -> proxy executes it and continues the managed loop

Read/Bash/Edit/Task or another non-managed tool call
  -> response is returned unchanged to Claude Code

visible text
  -> returned as the completed response
```

A structured action plan is deliberately not considered a completed answer. Headings such as `Plan` or `Next steps`, imperative tool-oriented list items, explicit search/read/verification intent, or statements that evidence is still missing force the continuation route.

Final-channel recovery is intentionally conservative. It uses a short isolated request containing only the malformed candidate answer, replaces the original System prompt, disables thinking through request-level chat-template kwargs, and prohibits new facts or tool calls.

Recovery is bounded to one additional Base-model call for the invalid response. If that recovery still contains no valid visible answer or tool action, the proxy returns:

```text
response_recovery_exhausted
```

Recovery diagnostics retain the existing V0.2.13 file-based protocol bundles and add route metadata to the safe main-log events:

```text
managed_final_response_repair_start
  recovery_route=final_channel|continuation
  tools_preserved=true|false
  recovery_signals=...

managed_final_response_repair_success
  recovery_route=...
  tool_use_count=...

managed_final_response_recovery_tool_dispatch
  disposition=managed|unmanaged
  tool_names=[...]
```

No additional ENV setting is required.

## Persistent media cache

Claude Code sends complete message history on later tool rounds. A PDF/image Base64 block from an earlier `Read` can therefore appear again after `Write`, `Bash` or another tool result. V0.2.7 fingerprints decoded media and replaces every historical occurrence with the same cached normalized content instead of rerunning Poppler or the visual model.

The cache key includes:

```text
SHA-256(decoded media)
media MIME type
parser pipeline version
visual prompt version
VLLM_VISION_MODEL
VLLM_VISION_PROVIDER
visual API protocol
VLLM_VISION_THINK
RESOURCE_PROFILE
evidence contract version
```

Routing behavior:

```text
all media cache hits
  -> cached_transform
  -> no managed queue
  -> no visual-model call
  -> no visible proxy progress
  -> base-vLLM streaming starts directly

at least one media cache miss
  -> managed queue
  -> parse/analyze each unique media key once
  -> persist normalized result
```

Capacity is configured in MiB:

```env
MEDIA_CACHE_MAX_MB=0
```

Meaning:

- Unset outside Compose: use the selected resource-profile default (`512`, `2048` or `10240` MiB).
- `0`: disable capacity-based eviction and continue until the filesystem reports insufficient space.
- Positive value: enforce that many MiB using least-recently-used eviction.
- Negative or non-numeric value: configuration error; the proxy does not start.

Retention still applies when capacity is `0`: `small` targets three days, `default` seven days and `large` thirty days since last use. Expired entries are removed at startup and during later writes. Cache entries use atomic same-directory rename; incomplete temporary files are removed on startup.

If the filesystem returns `ENOSPC` or `EDQUOT`, the completed analysis is still used for the current request. Only persistence fails, `/health` changes to `degraded`, and a later request may need to analyze that media again.

## PDF flow

```text
Anthropic document/base64
-> Base64 and PDF magic validation
-> pdfinfo
-> pdftotext per page
-> render pages with pdftoppm when visual mode is enabled
-> count every page actually present in the received PDF payload
-> batches of at most four page images to the configured visual provider
-> report received pages, processed pages and visual batch count
-> merge native text and visual Markdown with page boundaries
-> replace document block with text
-> send to base vLLM
```

A text PDF can still be processed without a visual endpoint. A scanned or low-text PDF requires a visual provider; the proxy returns `vision_endpoint_required` instead of forwarding raw Base64. If Claude Code displays `Read(... · pages 1-20)`, the proxy processes every page present in the resulting PDF payload. A received 20-page PDF is processed as five sequential visual batches at the default batch size of four. The proxy cannot infer an original file page range when Claude Code does not include that metadata on the wire.

## Image flow

```text
Anthropic image/base64
-> MIME/magic and resource validation
-> ImageMagick auto-orient, resize and strip metadata
-> configured visual-provider analysis
-> replace image block with bounded visual Markdown
-> send to base vLLM
```

Raw image/PDF Base64 is never included in the request sent to the base vLLM. Native text and visual output are inserted only through the escaped structured-evidence contract.

## Model-requested crops

The visual model receives one proxy-owned tool:

```text
request_image_crop(source_id, bbox, purpose)
```

`bbox` uses normalized `[left, top, right, bottom]` coordinates from `0` to `1000`. The proxy validates the source and coordinates, crops the original normalized image, enlarges the crop within resource limits, and sends it back to the visual model.

Fixed limits:

- Maximum two crop rounds.
- Maximum four crop calls per round.
- Maximum six crops per source asset.
- No file paths or shell commands are accepted from the model.
- Crops smaller than one percent of the source are rejected internally.

A model-generated crop validation failure is returned to the visual model as a bounded tool result instead of becoming a Claude Code API error. The visual model may correct the crop or complete from existing evidence. After two crop rounds, the proxy disables crop tools and requests a final evidence-bounded answer. Unexpected proxy programming errors are not hidden by this recovery path.

## Streaming progress

Managed streaming requests open Anthropic SSE immediately. Two heartbeat layers are used:

```text
PROGRESS_PING_INTERVAL_MS=5000
  invisible Anthropic event: ping
  keeps TCP and intermediary connections active

PROGRESS_HEARTBEAT_MS=30000
  visible Anthropic content_block_delta
  keeps Claude Code's semantic stream watchdog active
```

Every actual state revision is sent immediately as an Anthropic `content_block_delta`; the 30-second visible heartbeat is used only when the current state has not changed. Before the 1.5-second visibility threshold, the proxy retains the latest pending snapshot instead of discarding early updates. If the task is still active when the threshold expires, that latest state is emitted immediately.

For a Web-only request, merely having `WebSearch` or `WebFetch` available no longer creates a visible `目前處理進度：` block. The first planning round remains invisible unless it lasts until the semantic-heartbeat threshold. A real managed tool call, queue wait, media operation, retry or repair activates progress immediately. A short direct Base-model answer therefore remains visually transparent.

The visible heartbeat remains active while the proxy is parsing media, waiting for a visual-model response, waiting for Base vLLM response headers, or waiting for the first real Base vLLM content event. Base lifecycle transitions are also visible immediately:

```text
正在將內容送往主模型…
主模型已接受請求，正在準備輸出…
主模型已開始回傳本輪回答…
```

The heartbeat stops before the first upstream thinking, text or tool-use content block is forwarded.

File-aware progress uses only a safe basename. When Claude Code includes a `Read` tool call in message history, the proxy associates nested PDF/image blocks with the original `file_path` but never displays the full local path. Examples:

```text
目前處理進度：
檔案：GW305_N101_20260519-board.pdf｜圖片 4/15｜狀態：正在使用視覺模型分析圖片…
檔案：GW305_N101_20260519-board.pdf｜頁面 8/15（53%）｜批次 2/4｜狀態：視覺模型已完成 8/15 頁…
檔案：GW305_N101_20260519-board.pdf｜處理進度 15/15（100%）｜狀態：文件與圖片內容已就緒；正在交給主模型分析…
檔案：GW305_N101_20260519-board.pdf｜狀態：主模型仍在處理本輪請求，已等待 30 秒…
```

If filename metadata and the corresponding Read tool call are both unavailable, the proxy falls back to `PDF #N` or `圖片 #N`. Multiple media blocks associated with one Read call are shown as image or document-segment progress instead of unrelated generic messages.

When progress becomes visible, it is emitted as a dedicated first text block headed `目前處理進度：`. No hidden nonce or `VLLMCCP:v1:*` marker is emitted. Before a later request reaches the base vLLM, the proxy removes that dedicated block structurally. Legacy readable progress blocks and V0.2.2 sentinel-wrapped history are also cleaned for backward compatibility.

SSE writes use a bounded drain wait (`SSE_DRAIN_TIMEOUT_MS=10000`). Logs distinguish a state change, requested status and confirmed write through `progress_state_changed`, `managed_task_progress` (`delivery_status=requested`) and `progress_sse_sent`. Confirmed writes include a state revision and delivery latency. Base vLLM timing logs include request start, response headers, first model content event, stream completion and stage-specific request failure without recording prompt text:

```text
base_upstream_request_start
base_upstream_headers_received
base_upstream_first_event
base_upstream_stream_completed
base_upstream_request_failed
```

After PDF/image preprocessing finishes, the managed slot is released and the final Base vLLM answer is streamed token-by-token into the same Anthropic SSE response. Proxy-owned WebSearch/WebFetch tool rounds still require complete tool-call JSON internally; their final result is emitted after the bounded loop completes.

## Concurrency and queue

Only managed workflows enter the proxy queue. Plain text, Claude Code native tools and arbitrary bypass endpoints are not queued by the proxy and remain subject to the base vLLM scheduler.

Default configuration:

```env
CONCURRENCY_PROFILE=default
```

Profiles:

| Profile | Managed active | Managed waiting | Queue timeout | Vision active |
|---|---:|---:|---:|---:|
| `small` | 1 | 4 | 120 s | 1 |
| `default` | 2 | 12 | 120 s | 1 |
| `large` | 4 | 32 | 180 s | 2 |

Advanced overrides are optional:

```env
MANAGED_MAX_CONCURRENCY=
MANAGED_MAX_QUEUE=
MANAGED_QUEUE_TIMEOUT_MS=
VISION_MAX_CONCURRENCY=
```

Streaming progress settings:

```env
PROGRESS_VISIBLE_AFTER_MS=1500
PROGRESS_PING_INTERVAL_MS=5000
PROGRESS_HEARTBEAT_MS=30000
SSE_DRAIN_TIMEOUT_MS=10000
```

Queue behavior:

- FIFO admission with no priority insertion.
- Full queue returns `429 proxy_queue_full` and `Retry-After: 10`.
- Expired wait returns `503 proxy_queue_timeout` and `Retry-After: 10`.
- Streaming callers receive SSE pings and visible queue-position updates.
- Client disconnect removes a waiting job or aborts active Poppler, ImageMagick, visual vLLM, WebSearch/WebFetch and base-vLLM work.
- Media is decoded into a request-scoped private temporary directory before queueing; Base64 is not retained by queued jobs.

The health endpoint exposes only aggregate counters:

```json
{
  "managed": { "active": 1, "limit": 2, "queued": 3, "queue_limit": 12 },
  "vision": { "active": 1, "limit": 1 },
  "cache": {
    "entries": 42,
    "bytes": 183500800,
    "max_bytes": 0,
    "limit_mode": "filesystem",
    "write_available": true,
    "inflight_analyses": 1
  }
}
```

## Managed web tools

```env
SEARXNG_URL=http://host.docker.internal:8088
WEB_FETCH_URL=http://host.docker.internal:8090/
WEB_FETCH_API_KEY=

WEB_FETCH_PROCESSOR_ENABLED=true
WEB_FETCH_PROCESSOR_PROVIDER=vllm
WEB_FETCH_PROCESSOR_URL=
WEB_FETCH_PROCESSOR_MODEL=
WEB_FETCH_PROCESSOR_API_KEY=
WEB_FETCH_PROCESSOR_THINK=false
```

- `WebSearch` and `web_search` call SearXNG and return a readable multiline result list.
- Anthropic native `web_search_*` and `web_fetch_*` server-tool definitions are normalized into custom schemas before Count Tokens and model calls.
- Native `max_uses` and domain policies are enforced locally and are not forwarded to vLLM.
- `WebFetch` and `web_fetch` POST to the exact configured `WEB_FETCH_URL`; the proxy does not append `/v1/fetch`.
- The awesome-web-fetch request uses `{ "urls": [targetUrl] }`. An optional `WEB_FETCH_API_KEY` is sent only to that backend as a Bearer token.
- Array responses using `page_content` and `metadata` are normalized; the older object response shape remains accepted.
- Raw page content is deterministically cleaned and protocol-neutralized, then an isolated WebFetch Processor applies the tool's `prompt` through `/v1/chat/completions` with no tools or Claude Code history.
- `WEB_FETCH_PROCESSOR_PROVIDER` accepts `vllm` or `ollama`. A root/base Processor URL automatically receives `/v1/chat/completions`; `/v1` receives `/chat/completions`; an already complete endpoint is unchanged. Blank Processor URL and MODEL inherit the Base vLLM endpoint and current request model. The API key inherits `VLLM_BASE_API_KEY` only while the Processor URL is also derived from Base; an explicit Processor URL requires `WEB_FETCH_PROCESSOR_API_KEY`. For provider `vllm`, `WEB_FETCH_PROCESSOR_THINK` maps to `chat_template_kwargs.enable_thinking`. For provider `ollama`, it maps to OpenAI-compatible `reasoning_effort` (`none` when false, `high` when true). `WEB_FETCH_PROCESSOR_THINK` is a strict boolean and defaults to `false`. `WEB_FETCH_PROCESSOR_CONCURRENCY` defaults to 3 and is bounded to 1..3; `WEB_FETCH_PROCESSOR_TIMEOUT_MS` defaults to 300000 ms.
- Successful WebSearch/WebFetch results are readable multiline VCC evidence blocks rather than JSON-stringified objects. One short idempotent System supplement explains the result fields to the Base model.
- Processor timeout, HTTP failure, invalid response, tool-call output or protocol-tag leakage degrades to a bounded cleaned excerpt; the complete raw page is not forwarded as fallback.
- HTTP rejection, robots denial and other expected fetch-service failures become correlated `tool_result` blocks with `is_error: true`. The Base model may choose another source instead of terminating the complete Claude Code request.
- Unexpected proxy programming failures still abort the request. Managed loops remain bounded to six rounds by default.
- WebFetch applies URL and SSRF validation before contacting the backend.
- Safe diagnostics never contain API keys, fetched page text, extraction prompts or Processor output:

```text
web_fetch_upstream_request
web_fetch_upstream_response
web_fetch_upstream_rejected
web_fetch_processor_request
web_fetch_processor_response
web_fetch_processor_fallback
```


## Protocol anomaly diagnostics

Normal logs continue to record only counts, block metadata and repair state. To capture complete malformed fields when the managed final-response guard starts a repair, enable:

```env
LOG_LEVEL=info
LOG_PROTOCOL_SNIPPETS=true
```

`LOG_PROTOCOL_SNIPPETS` remains the only switch and accepts strictly `true` or `false`. V0.2.13 no longer expands anomaly fragments in the main log. Each original or repaired malformed response is written as one atomic JSON file under:

```text
/tmp/vllm-cc-tools-proxy/protocol-snippets
```

The filename is time ordered and includes the request ID, managed round and phase:

```text
20260806T074827.545Z__507e5d7e-121b-4c92-8283-8783bb594e3d__r02__original__a1b2c3d4.json
20260806T074900.120Z__507e5d7e-121b-4c92-8283-8783bb594e3d__r02__repair__e5f6a7b8.json
```

The main log contains only one retrievable reference event:

```text
managed_final_response_diagnostic_file
```

Its safe fields include:

```text
requestId
round
repair
reasons
output_snippet_count
input_snippet_count
file_path
file_bytes
file_sha256
created_at
```

It does not contain the malformed output, surrounding text, System prompt fragment, message-history fragment or Tool Description fragment. If the file cannot be created, the request continues normally and a content-free event is emitted:

```text
managed_final_response_diagnostic_file_failed
```

Each JSON file contains:

- response ID, model, stop reason and content-block types;
- every detected output location with tag, path, offset, line and column;
- the complete redacted anomalous output field in `full_text_redacted`;
- matching System, message-history and Tool Description fields in `full_text_redacted`;
- bounded nearby excerpts and SHA-256 content fingerprints;
- separate `original_response` or `repair_response` phase metadata.

Credentials are redacted before persistence. Bearer values, common API-key/token/password/secret assignments, known key prefixes and URL user information are replaced with `[REDACTED]`. Diagnostic files are created with private permissions and completed using atomic rename, so collectors do not read partially written JSON.

To list and retrieve files from the Compose container:

```bash
docker exec vllm-cc-tools-proxy \
  sh -lc 'ls -lt /tmp/vllm-cc-tools-proxy/protocol-snippets'

docker cp \
  vllm-cc-tools-proxy:/tmp/vllm-cc-tools-proxy/protocol-snippets \
  ./protocol-snippets
```

The directory is inside the container temporary filesystem. It survives a normal process restart in the same container but is not intended as a persistent archive and can disappear when the container is recreated. Copy the files out after reproducing the issue, then disable collection:

```env
LOG_PROTOCOL_SNIPPETS=false
```

## Resource profiles

- `small`: 12 MiB media, 40 PDF pages.
- `default`: 32 MiB media, 100 PDF pages.
- `large`: 96 MiB media, 300 PDF pages.

The default visual PDF batch size is four pages.

## Security boundaries

- MIME and magic-byte validation.
- Request, decoded-byte, page, pixel, output and subprocess limits.
- Argument-array subprocess execution; no shell interpolation for file processing.
- Private media-processing temporary directories are removed after each request.
- Separate Authorization headers for base and visual vLLM.
- Client disconnect abort propagation to Poppler, ImageMagick, visual vLLM and base vLLM.
- No Base64, document text or sensitive paths in normal logs.
- PDF/visual source text is HTML-entity escaped and checked by a neutral-evidence invariant before base-vLLM forwarding.
- Known malformed protocol tags in structured assistant thinking history and managed tool-result evidence are neutralized without rewriting valid visible assistant text.
- Managed final output is validated before progress is closed; one tools-disabled repair is allowed, then malformed output is rejected.

## Verification

```bash
./scripts/verify.sh
```

The suite covers request-side and response-side native Web Search/Web Fetch normalization, Native Server Tool containment, mixed-tool deferral, native policy enforcement, explicit Count Tokens compatibility, Anthropic usage normalization, managed `/v1/messages/count_tokens` preflight, auto-compact usage compatibility, non-fatal preflight fallback, direct-stream usage observation, transparent bypass, raw-body preservation, Claude Code hello probes, FIFO admission, queue full/timeout/cancellation, persistent cache/TTL/LRU/disk-full behavior, request-local deduplication, cross-request singleflight, vLLM/Ollama visual serialization, strict thinking control, internal crop recovery, 20-page batching, configuration, deployment contract, nested content blocks, PDF extraction, scanned-page visual routing, image normalization, crop authorization, bounded visual tool loops, API-key separation, awesome-web-fetch request/response compatibility, isolated prompt-directed WebFetch processing, readable multiline web evidence, Processor fallback, recoverable managed-tool errors, file-aware progress, immediate state revisions, semantic Anthropic SSE heartbeat, drain-timeout handling, Base-vLLM connect/header/body timeout classification, TTFT observability, structured-evidence escaping, contaminated-thinking sanitation, recursive managed-tool evidence neutralization, final-response validation/repair, lazy Web-only progress activation, protocol provenance diagnostics, atomic file-based anomaly evidence, cache-contract invalidation and split control-tag diagnostics across SSE deltas.

## V0.2.18 limits

- DOCX, XLSX and PPTX still require a future host-side document bridge.
- Visual analysis depends on the selected multimodal model and the provider-specific tool-call protocol/template.
- Queue, semaphore and singleflight state are process-local; multiple proxy replicas do not share admission state.
- Cache files are persistent, but multiple proxy replicas do not coordinate cache writes or distributed locks.
- No persistent document-handle API or distributed Redis cache.

## V0.2.21-diagnostic.1: Claude Code built-in Web tool trace

This diagnostic prerelease is for determining whether Claude Code's visible `Web Search(...)` / `Web Fetch(...)` UI is driven by its built-in client-tool lifecycle rather than Anthropic server-tool blocks.

Enable the probe explicitly:

```env
DIAGNOSTIC_WEB_TOOL_PASSTHROUGH=true
DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT=1
DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT=1
DIAGNOSTIC_WEB_TOOL_TRACE=true
DIAGNOSTIC_WEB_TOOL_TRACE_DIR=/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace
```

When enabled, the first eligible WebSearch and first eligible WebFetch produced by the Base model are returned to Claude Code as ordinary `tool_use` blocks without Proxy execution. Search and Fetch quotas are independent. This intentionally allows Claude Code to execute its built-in tools so the native UI and return path can be observed.

Complete diagnostic records are written under:

```text
/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace/<session-id>/
```

Each event is a pretty JSON file and `index.jsonl` lists event order. Trace events include:

- `client_request`: complete redacted Anthropic Messages request received from Claude Code.
- `base_model_request`: exact managed request sent to the local Base model.
- `base_model_response`: complete Base model response before Proxy web-tool execution.
- `diagnostic_web_tool_passthrough`: exact tool-use response intentionally handed to Claude Code.
- `proxy_response`: complete response prepared for Claude Code.
- `client_tool_result_returned`: a later Claude Code request containing a correlated passthrough `tool_result`.
- `client_unmanaged_request`: any non-Messages HTTP route reaching the Proxy, including method/path/query/headers/body, so alternate built-in Web backends are discoverable.

Authorization, API keys, tokens, cookies, passwords and secret-shaped fields are redacted. User/model/tool content is otherwise retained because this build is specifically for protocol diagnosis. Disable the diagnostic flags after one capture.
