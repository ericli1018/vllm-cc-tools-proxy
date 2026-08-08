// Compatibility exports retained for older internal callers.
// Since V0.2.26.4 response language is enforced only at final-response
// post-processing time, model requests are no longer mutated here.
export function injectResponseLanguageTail(request) {
  return { request: structuredClone(request || {}), changed: false };
}

export function injectResponseLanguagePolicy(request) {
  return { request: structuredClone(request || {}), changed: false };
}
