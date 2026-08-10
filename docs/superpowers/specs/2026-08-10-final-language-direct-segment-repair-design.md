# Final Language Direct-Segment Repair Design

## Goal

Make Final Language Repair reliable by removing the model-visible segment-marker protocol. Proxy owns text-block mapping; repair backends only translate one plain-text segment at a time.

## Scope

Version: `0.2.28.6`.

Only Final Language Repair changes. Managed Loop, controlled continuation, WebFetch processing, PDF/Vision evidence, and media cache semantics remain unchanged.

## Data flow

1. Final Language Gate detects a non-compliant final response.
2. Proxy enumerates final `text` blocks and preserves their content indices.
3. External backend receives each text block as an isolated plain-text translation request.
4. Proxy validates each translated segment for non-empty visible text and target-language compliance.
5. If external repair fails, Base receives the same individual source segments through an isolated tool-less request path.
6. Proxy deterministically writes translated text back to the original text-block indices.
7. If every backend fails, the original successful response is preserved.

## Segment contract

The language model MUST NOT be responsible for preserving synthetic segment markers or mapping multiple blocks.

For every repair backend invocation:

- Input is exactly one natural-language segment plus a translation-only instruction.
- No `<<<VCC_LANG_SEGMENT_*>>>` markers are sent.
- No tools are exposed.
- Reasoning remains disabled/preserved-thinking false where supported.
- Output is accepted only from visible assistant text.
- Tool calls, empty content, malformed payloads, or non-compliant target language are failures.

For multiple text blocks, Proxy invokes the repair backend once per segment and reassembles them by original index.

## Diagnostics

Add safe per-segment metadata without raw text:

- `final_language_processor_request`: `segment_index`, `segment_count`, `input_chars`.
- `final_language_processor_response`: `segment_index`, `segment_count`, `output_chars`, elapsed time.
- Failure events preserve backend/error/fallback semantics.

## Compatibility

- No new ENV variables.
- Reuse existing external language processor configuration.
- Keep Final Language Gate language classifier and original-response safety fallback.
- Keep cache generations unchanged: `media-v7 / visual-v10 / evidence-v6`.
