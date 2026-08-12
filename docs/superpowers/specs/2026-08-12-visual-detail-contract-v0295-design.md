# V0.29.5 Visual Detail Contract Design

## Goal

Separate whether an image contains real content from whether the current visual scale is sufficient for reliable detail extraction.

## Contract

For evidence-mode Vision output:

- `VISUAL_STATUS: CONTENT` requires `VISUAL_DETAIL: SUFFICIENT | NEEDS_ZOOM`.
- `VISUAL_DETAIL: SUFFICIENT` plus valid `VISUAL_EVIDENCE` is cacheable final evidence.
- `VISUAL_DETAIL: NEEDS_ZOOM` is actionable and non-cacheable; callers use the existing crop/overlapping-tile path.
- Missing `VISUAL_DETAIL` on `CONTENT` is contract-invalid and must be recovered, never inferred as `SUFFICIENT`.
- Legacy `VISUAL_STATUS: NEEDS_ZOOM` remains accepted as actionable zoom for compatibility.
- `BLANK` remains a valid final state without invented evidence.
- `UNREADABLE` remains weak evidence and must not be guessed from.

## Scope

- Update Vision system/recovery contract and parser/classifier.
- Preserve local repair only for evidence-marker formatting; it must not invent `VISUAL_DETAIL`.
- Propagate `visualDetail` through diagnostics and return values.
- Reuse existing generic overlapping zoom and PDF tiling dispatch through `needsZoom`.
- Bump visual prompt and evidence cache generations.
- Update tests, README, changelog, package/version metadata, and manifest.

## Out of scope

- Image-density heuristics.
- Media cache fast-path redesign.
- Base64/history context slimming.
- Changes to generic tile geometry or overlap percentage.
