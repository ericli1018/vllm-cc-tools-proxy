# V0.2.12 Protocol Anomaly Logging Design

## Goal

When the managed final-response guard detects malformed model output, emit enough bounded context to identify the exact generated fragment and any matching protocol dialect already present in the request, without logging secrets by default.

## Configuration

Add one opt-in environment variable:

- `LOG_PROTOCOL_SNIPPETS=false` by default.
- When `true`, detailed anomaly snippets are emitted as structured JSON log events.

Context sizes and redaction rules remain internal constants to avoid expanding deployment configuration.

## Output diagnostics

For every control-tag match in the invalid response, emit `managed_final_response_anomaly_snippet` with response phase, round, repair flag, block index/type/field, tag name/raw spelling, character offset, line/column, bounded before/after context, content size and SHA-256 fingerprint.

For `final_answer_in_thinking`, emit a bounded head/tail excerpt for every non-empty thinking block. For `missing_visible_text`, emit a bounded preview of each returned content block.

When repair starts, scan the current request's system, messages and tool definitions. Emit `managed_final_response_input_protocol_snippet` for every protocol tag found, including its structured path and bounded context. This distinguishes model-generated dialect drift from prompt/history priming.

Original and repaired outputs are diagnosed separately. A summary event reports emitted snippet counts.

## Safety

Detailed snippets are disabled by default. Before logging, redact bearer credentials, common API key/token/password/secret assignments, known key prefixes and URL userinfo. Snippets are bounded; full prompts, web pages and complete model responses are never logged.

## Testing

Tests cover exact location/context, multiline line/column reporting, credential redaction, thinking-only output, request provenance, disabled behavior, original versus repaired output and proxy log integration.
