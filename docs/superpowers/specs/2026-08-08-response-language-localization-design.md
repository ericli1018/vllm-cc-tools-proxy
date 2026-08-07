# V0.2.23 Response Language & Status Localization Design

## Goal
Add one runtime setting, `MODEL_RESPONSE_LANGUAGE`, that controls the default user-visible Base-model language, WebFetch Processor output language, and Proxy-generated progress/status text.

## Supported locales
- `zh-TW`
- `zh-CN`
- `en-US`
- `ja-JP`
- `ko-KP`

Missing, blank, or unsupported values resolve to `en-US`. Matching is case-insensitive and emitted configuration uses the canonical locale spelling above.

## Prompt contract
Main Base-model instruction remains one short sentence per locale, e.g.:

`Default to Traditional Chinese (zh-TW) for user-visible responses. Preserve technical literals verbatim.`

WebFetch Processor uses a shorter locale-specific sentence, e.g.:

`Write the result in Traditional Chinese (zh-TW).`

The Main-model instruction is appended to the Anthropic `system` representation without replacing Claude Code system content and is idempotent. It applies to ordinary, managed, media, native WebSearch child, streaming, non-streaming, and count-token requests. The WebFetch 200-content Processor child is routed directly to the configured Processor and receives the Processor instruction instead.

## Status localization
A single locale registry owns all Proxy user-visible status vocabulary. It localizes:
- progress block header;
- model wait/stream/handoff/final messages;
- WebSearch/WebFetch managed progress;
- queue messages;
- media/PDF/image labels and progress;
- Base upstream lifecycle messages;
- recovery/final-round messages.

Technical literals such as URLs, filenames, hostnames, query text, tool names, API names, and numeric counters are interpolated without translation.

Progress-history stripping recognizes all five current localized headers plus historical legacy headers so a locale change cannot leak old progress blocks back to the model.

## Compatibility
No existing ENV is removed. Diagnostic flags remain unchanged. `MODEL_RESPONSE_LANGUAGE` is the only new ENV. Runtime version becomes `0.2.23`.

## Verification
TDD coverage must prove locale resolution/fallback, system policy injection, Processor instruction, localized progress headers/history stripping, localized model/tool/media statuses, plain-request transformation, deployment ENV wiring, and release version. Full regression, syntax check, `verify.sh`, package manifest, and extracted ZIP verification are required.
