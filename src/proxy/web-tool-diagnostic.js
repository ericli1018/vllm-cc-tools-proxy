import { canonicalWebToolName } from './native-web-tools.js';

function managedEntries(toolUses) {
  return (Array.isArray(toolUses) ? toolUses : [])
    .map((tool) => ({ tool, canonical: canonicalWebToolName(tool?.name) }))
    .filter((entry) => Boolean(entry.canonical));
}

export function createWebToolDiagnosticController({
  enabled = false,
  searchPassthroughCount = 1,
  fetchPassthroughCount = 1,
} = {}) {
  let searchRemaining = Math.max(0, Number(searchPassthroughCount) || 0);
  let fetchRemaining = Math.max(0, Number(fetchPassthroughCount) || 0);
  const passthroughToolIds = new Map();

  function quotaFor(canonical) {
    return canonical === 'WebSearch' ? searchRemaining : fetchRemaining;
  }

  function decrement(canonical) {
    if (canonical === 'WebSearch') searchRemaining -= 1;
    else if (canonical === 'WebFetch') fetchRemaining -= 1;
  }

  return {
    decide({ toolUses } = {}) {
      if (!enabled) return { passthrough: false, reason: 'disabled' };
      const entries = managedEntries(toolUses);
      if (entries.length === 0) return { passthrough: false, reason: 'no_managed_web_tool' };
      if (entries.some((entry) => quotaFor(entry.canonical) <= 0)) {
        return { passthrough: false, reason: 'quota_unavailable' };
      }
      for (const entry of entries) {
        decrement(entry.canonical);
        const id = String(entry.tool?.id || '');
        if (id) passthroughToolIds.set(id, entry.canonical);
      }
      return {
        passthrough: true,
        reason: 'diagnostic_passthrough',
        tool_ids: entries.map((entry) => String(entry.tool?.id || '')),
        tool_names: entries.map((entry) => String(entry.tool?.name || '')),
        canonical_names: entries.map((entry) => entry.canonical),
        search_remaining: searchRemaining,
        fetch_remaining: fetchRemaining,
      };
    },

    findReturnedToolResults(messages) {
      const found = [];
      for (const message of Array.isArray(messages) ? messages : []) {
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks) {
          if (block?.type !== 'tool_result') continue;
          const id = String(block?.tool_use_id || '');
          const canonical = passthroughToolIds.get(id);
          if (!canonical) continue;
          found.push({
            canonical,
            tool_use_id: id,
            block: structuredClone(block),
          });
        }
      }
      return found;
    },

    snapshot() {
      return {
        enabled: Boolean(enabled),
        search_remaining: searchRemaining,
        fetch_remaining: fetchRemaining,
        pending_tool_ids: [...passthroughToolIds.keys()],
      };
    },
  };
}
