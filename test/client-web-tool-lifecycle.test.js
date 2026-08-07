import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientWebToolLifecycleRegistry,
  parseClaudeCodeWebFetchProcessorChild,
  webFetchResultNeedsFallback,
} from '../src/proxy/client-web-tool-lifecycle.js';

test('V0.2.22 detects Claude Code WebFetch 200-content processor child and extracts source plus prompt', () => {
  const request = {
    model: 'claude-sonnet-4-6', stream: true, tools: [],
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `\nWeb page content:\n---\nPAGE BODY\n---\n\nSummarize this page.\n\nProvide a concise response based only on the content above. In your response:\n - Never produce exact song lyrics.\n` }] }],
  };
  assert.deepEqual(parseClaudeCodeWebFetchProcessorChild(request), {
    sourceText: 'PAGE BODY',
    prompt: 'Summarize this page.',
  });
});

test('V0.2.22 processor-child detector rejects ordinary main-agent requests', () => {
  assert.equal(parseClaudeCodeWebFetchProcessorChild({
    tools: [{ name: 'WebFetch' }],
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Web page content:\n---\nnot a child' }] }],
  }), null);
});

test('V0.2.22 lifecycle registry correlates the latest WebFetch handoff with the processor child session', () => {
  let now = 1000;
  const registry = new ClientWebToolLifecycleRegistry({ now: () => now, ttlMs: 60_000, maxEntries: 8 });
  registry.recordToolUses('session-a', [
    { type: 'tool_use', id: 'f1', name: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'A' } },
  ]);
  now += 10;
  const pending = registry.claimLatestWebFetch('session-a', { prompt: 'A' });
  assert.equal(pending.tool_use_id, 'f1');
  assert.equal(pending.input.url, 'https://example.com/a');
  assert.equal(registry.claimLatestWebFetch('session-a', { prompt: 'A' }), null);
});

test('V0.2.22 redirect and explicit fetch errors trigger fallback while successful summaries do not', () => {
  assert.equal(webFetchResultNeedsFallback({ type: 'tool_result', content: 'REDIRECT DETECTED: moved\nStatus: 302 Found' }), true);
  assert.equal(webFetchResultNeedsFallback({ type: 'tool_result', is_error: true, content: 'network failed' }), true);
  assert.equal(webFetchResultNeedsFallback({ type: 'tool_result', content: 'Unable to fetch URL: timeout' }), true);
  assert.equal(webFetchResultNeedsFallback({ type: 'tool_result', content: '# Summary\nThe page loaded successfully.' }), false);
});
