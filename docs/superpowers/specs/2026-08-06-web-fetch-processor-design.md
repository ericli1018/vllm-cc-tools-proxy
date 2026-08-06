# V0.2.11 WebFetch Processor Design

## Goal

Make managed `WebFetch(url, prompt)` behave as prompt-directed content extraction instead of forwarding a raw fetched page to the Base model.

## Architecture

1. `awesome-web-fetch` retrieves the source page and metadata.
2. The proxy deterministically cleans and protocol-neutralizes the source.
3. When enabled, an isolated OpenAI-compatible `/v1/chat/completions` call processes the source according to the WebFetch `prompt`.
4. The processor receives no Claude Code history, no tools, and no managed-loop protocol state.
5. The processor output is validated. Failure degrades to a bounded cleaned excerpt rather than the full raw page.
6. The managed loop renders WebSearch and WebFetch results as readable multiline evidence, not JSON strings.
7. A short, idempotent System supplement explains the VCC web-result fields to the Base model only after managed web evidence exists.

## Configuration

Expose only five Processor variables:

```env
WEB_FETCH_PROCESSOR_ENABLED=true
WEB_FETCH_PROCESSOR_URL=
WEB_FETCH_PROCESSOR_MODEL=
WEB_FETCH_PROCESSOR_API_KEY=
WEB_FETCH_PROCESSOR_THINK=false
```

Inheritance:

- Blank URL derives `/v1/chat/completions` from `VLLM_BASE_URL`.
- Blank model uses the current Anthropic request `model`.
- Blank API key inherits `VLLM_BASE_API_KEY` only when the Processor URL is also derived from Base. An explicit Processor URL requires `WEB_FETCH_PROCESSOR_API_KEY`.
- THINK defaults to `false` and is forwarded through `chat_template_kwargs.enable_thinking`.

## Result contract

WebFetch results use a readable multiline block with:

- `source`: requested/final URL, title, HTTP status, content type, retrieval time, browser-rendered state.
- `processing`: mode, truncation, warnings.
- `result`: prompt-directed processor output or cleaned fallback excerpt.
- `selected_evidence`: optional bounded evidence returned by the processor.

WebSearch results use a compact readable result list. No `JSON.stringify(object)` is used for successful managed tool evidence.

## Safety

- Raw source content is untrusted data.
- Deterministic cleanup removes control bytes, repeated lines, repetitive filler and excessive blank lines.
- Known protocol tags and reserved Web/VCC result-boundary markers are neutralized before Processor and Base-model use.
- Processor receives no tools and may return only visible text.
- Processor protocol mismatch, timeout or upstream failure becomes a bounded fallback result.
- API keys, raw page bodies and processor prompts are not logged.

## Progress and diagnostics

WebFetch progress remains concise: `正在讀取並整理 <host>…` and `<host> 內容已就緒。`

Safe diagnostics:

- `web_fetch_processor_request`
- `web_fetch_processor_response`
- `web_fetch_processor_fallback`

They include hosts, status, timing, mode and character counts only.

## Verification

Tests must cover configuration inheritance, THINK and API-key forwarding, prompt use, isolated request shape, cleaning, readable result formatting, System supplement idempotence, protocol guard, fallback behavior, deployment variables and full regression.
