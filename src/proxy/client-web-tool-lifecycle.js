import { canonicalWebToolName } from './native-web-tools.js';

const CHILD_PREFIX = 'Web page content:\n---\n';
const CHILD_SUFFIX_MARKER = '\n---\n\n';
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const POST_PROCESSING_INSTRUCTION = '\n\nProvide a concise response based only on the content above.';

function textBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function systemContainsClaudeCode(system) {
  if (typeof system === 'string') return system.includes(CLAUDE_CODE_SYSTEM);
  if (!Array.isArray(system)) return false;
  return system.some((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.includes(CLAUDE_CODE_SYSTEM));
}

export function parseClaudeCodeWebFetchProcessorChild(request) {
  if (!request || !Array.isArray(request.messages) || request.messages.length !== 1) return null;
  if (Array.isArray(request.tools) && request.tools.length > 0) return null;
  if (!systemContainsClaudeCode(request.system)) return null;
  const message = request.messages[0];
  if (message?.role !== 'user') return null;
  const text = textBlocks(message.content);
  const start = text.indexOf(CHILD_PREFIX);
  if (start < 0) return null;
  const contentStart = start + CHILD_PREFIX.length;
  const delimiter = text.lastIndexOf(CHILD_SUFFIX_MARKER);
  if (delimiter < contentStart) return null;
  const sourceText = text.slice(contentStart, delimiter).trim();
  let prompt = text.slice(delimiter + CHILD_SUFFIX_MARKER.length).trim();
  const standardSuffix = prompt.indexOf(POST_PROCESSING_INSTRUCTION.trimStart());
  if (standardSuffix >= 0) prompt = prompt.slice(0, standardSuffix).trim();
  if (!sourceText || !prompt) return null;
  return { sourceText, prompt };
}

export function webFetchResultNeedsFallback(block) {
  if (block?.type !== 'tool_result') return false;
  if (block.is_error === true) return true;
  const content = typeof block.content === 'string' ? block.content.trim() : '';
  if (!content) return false;
  if (/^REDIRECT DETECTED:/i.test(content)) return true;
  if (/^(?:Unable to fetch|WebFetch failed|Fetch failed|Error fetching|Request failed)/i.test(content)) return true;
  return false;
}

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text.slice(0, 200);
}

export class ClientWebToolLifecycleRegistry {
  constructor({ ttlMs = 30 * 60_000, maxEntries = 512, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.enriched = new Map();
  }

  #key(sessionId, toolUseId) {
    return `${normalizeSessionId(sessionId)}\u0000${String(toolUseId || '')}`;
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) if (entry.created_at < cutoff) this.entries.delete(key);
    for (const [key, entry] of this.enriched) if (entry.created_at < cutoff) this.enriched.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    while (this.enriched.size > this.maxEntries) this.enriched.delete(this.enriched.keys().next().value);
  }

  recordToolUses(sessionId, toolUses) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return;
    for (const tool of Array.isArray(toolUses) ? toolUses : []) {
      const canonical = canonicalWebToolName(tool?.name);
      const id = String(tool?.id || '');
      if (!canonical || !id) continue;
      this.entries.set(this.#key(sid, id), {
        session_id: sid,
        tool_use_id: id,
        canonical,
        input: structuredClone(tool?.input || {}),
        created_at: this.now(),
        child_claimed: false,
      });
    }
    this.#prune();
  }

  get(sessionId, toolUseId) {
    this.#prune();
    return this.entries.get(this.#key(sessionId, toolUseId)) || null;
  }

  claimLatestWebFetch(sessionId, { prompt = '' } = {}) {
    this.#prune();
    const sid = normalizeSessionId(sessionId);
    const wantedPrompt = String(prompt || '').trim();
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.session_id === sid && entry.canonical === 'WebFetch' && !entry.child_claimed)
      .sort((a, b) => b.created_at - a.created_at);
    let selected = candidates.find((entry) => wantedPrompt && String(entry.input?.prompt || '').trim() === wantedPrompt);
    if (!selected) selected = candidates[0];
    if (!selected) return null;
    selected.child_claimed = true;
    return structuredClone(selected);
  }

  getEnriched(sessionId, toolUseId) {
    this.#prune();
    return this.enriched.get(this.#key(sessionId, toolUseId))?.value || null;
  }

  setEnriched(sessionId, toolUseId, value) {
    const key = this.#key(sessionId, toolUseId);
    this.enriched.set(key, { created_at: this.now(), value: structuredClone(value) });
    this.#prune();
  }
}
