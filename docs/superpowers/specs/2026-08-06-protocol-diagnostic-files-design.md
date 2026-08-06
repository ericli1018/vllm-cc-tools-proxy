# V0.2.13 Protocol Diagnostic Files Design

## Goal

When `LOG_PROTOCOL_SNIPPETS=true`, write complete redacted protocol anomaly evidence to timestamped temporary JSON files instead of expanding fragments in the main structured log.

## Behavior

- Keep `LOG_PROTOCOL_SNIPPETS` as the only user-facing switch.
- Use the internal temporary directory `<os.tmpdir()>/vllm-cc-tools-proxy/protocol-snippets`.
- Create one file for each original or repaired malformed response inspection.
- Name files with UTC timestamp, request ID, managed round, original/repair phase and a collision-safe suffix.
- Write atomically using a private temporary file followed by rename.
- Set directory permissions to `0700` and file permissions to `0600` where supported.
- Store full redacted anomalous fields, bounded positional excerpts, request provenance matches, response metadata and hashes.
- Emit only `managed_final_response_diagnostic_file` in the main log with path, byte count, SHA-256 and match counts.
- Do not emit `managed_final_response_anomaly_snippet` or `managed_final_response_input_protocol_snippet` into the main log.
- A file write failure emits a content-free `managed_final_response_diagnostic_file_failed` event and does not alter repair or task execution.
- When disabled, create no diagnostic files and preserve current count-only inspection logs.

## Security

Existing credential redaction remains mandatory before file persistence. The file must not contain raw Bearer values, API keys, passwords, secrets, URL user information or known key prefixes. No raw unredacted prompt or response may be passed to the file store.

## Compatibility

This release changes diagnostic storage only. Managed WebSearch/WebFetch execution, non-managed tool handoff, final-response inspection and repair behavior remain unchanged.

## Verification

- Unit-test atomic file creation, filename format, permissions, hashes and JSON structure.
- Unit-test complete redacted anomaly field persistence.
- Verify managed-loop diagnostics call the file writer and never emit snippet content events.
- Verify proxy integration writes a retrievable file while the main log contains no malformed content or secrets.
- Run the complete Node test suite, syntax checks, package manifest verification and clean extraction verification.
