import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaContinuationCache } from '../src/cache/media-continuation-cache.js';

test('V0.29.9 continuation media cache isolates sessions and clones stored evidence', () => {
  const cache = new MediaContinuationCache();
  const value = { block: { type: 'text', text: 'partial evidence' }, cacheable: false };

  assert.equal(cache.set('session-a', 'media-key', value), true);
  value.block.text = 'mutated source';

  const first = cache.get('session-a', 'media-key');
  assert.equal(first.block.text, 'partial evidence');
  first.block.text = 'mutated read';
  assert.equal(cache.get('session-a', 'media-key').block.text, 'partial evidence');
  assert.equal(cache.get('session-b', 'media-key'), null);
});

test('V0.29.9 continuation media cache resets only the selected session', () => {
  const cache = new MediaContinuationCache();
  cache.set('session-a', 'one', { block: { type: 'text', text: 'A1' } });
  cache.set('session-a', 'two', { block: { type: 'text', text: 'A2' } });
  cache.set('session-b', 'one', { block: { type: 'text', text: 'B1' } });

  assert.equal(cache.resetSession('session-a'), 2);
  assert.equal(cache.get('session-a', 'one'), null);
  assert.equal(cache.get('session-b', 'one').block.text, 'B1');
});

test('V0.29.9 continuation media cache prunes expired sessions and bounds entries', () => {
  let now = 0;
  const cache = new MediaContinuationCache({ maxSessions: 2, maxEntriesPerSession: 2, retentionMs: 100, clock: () => now });
  cache.set('session-a', 'one', { block: { type: 'text', text: '1' } });
  cache.set('session-a', 'two', { block: { type: 'text', text: '2' } });
  cache.set('session-a', 'three', { block: { type: 'text', text: '3' } });
  assert.equal(cache.get('session-a', 'one'), null);
  assert.equal(cache.get('session-a', 'three').block.text, '3');

  cache.set('session-b', 'one', { block: { type: 'text', text: 'B' } });
  cache.set('session-c', 'one', { block: { type: 'text', text: 'C' } });
  assert.equal(cache.get('session-a', 'two'), null);
  assert.equal(cache.get('session-c', 'one').block.text, 'C');

  now = 101;
  assert.equal(cache.get('session-b', 'one'), null);
  assert.equal(cache.health().sessions, 0);
});

test('V0.29.12 continuation cache health reports bounded byte usage', () => {
  const cache = new MediaContinuationCache({ maxBytes: 4096, maxBytesPerSession: 2048 });
  cache.set('session-a', 'one', { block: { type: 'text', text: 'alpha' } });
  const health = cache.health();
  assert.equal(health.sessions, 1);
  assert.equal(health.entries, 1);
  assert.ok(health.bytes > 0);
  assert.equal(health.maxBytes, 4096);
  assert.equal(health.maxBytesPerSession, 2048);
});

test('V0.29.12 continuation cache evicts LRU entries when a session exceeds its byte budget', () => {
  const value = { block: { type: 'text', text: 'x'.repeat(256) } };
  const probe = new MediaContinuationCache({ maxBytes: 1_000_000, maxBytesPerSession: 1_000_000 });
  assert.equal(probe.set('probe', 'one', value), true);
  const oneEntryBytes = probe.health().bytes;
  assert.ok(oneEntryBytes > 0);

  const cache = new MediaContinuationCache({
    maxBytes: oneEntryBytes * 4,
    maxBytesPerSession: oneEntryBytes * 2 - 1,
  });
  assert.equal(cache.set('session-a', 'one', value), true);
  assert.equal(cache.set('session-a', 'two', value), true);
  assert.equal(cache.get('session-a', 'one'), null);
  assert.ok(cache.get('session-a', 'two'));
  assert.ok(cache.health().bytes <= cache.health().maxBytesPerSession);
});

test('V0.29.12 continuation cache evicts LRU sessions when global byte budget is exceeded', () => {
  const value = { block: { type: 'text', text: 'y'.repeat(256) } };
  const probe = new MediaContinuationCache({ maxBytes: 1_000_000, maxBytesPerSession: 1_000_000 });
  probe.set('probe', 'one', value);
  const oneEntryBytes = probe.health().bytes;

  const cache = new MediaContinuationCache({
    maxSessions: 16,
    maxEntriesPerSession: 64,
    maxBytes: oneEntryBytes * 2 - 1,
    maxBytesPerSession: oneEntryBytes * 2,
  });
  cache.set('session-a', 'one', value);
  cache.set('session-b', 'one', value);
  assert.equal(cache.get('session-a', 'one'), null);
  assert.ok(cache.get('session-b', 'one'));
  assert.ok(cache.health().bytes <= cache.health().maxBytes);
});

test('V0.29.12 continuation cache replacement reset and TTL pruning keep byte accounting exact', () => {
  let now = 0;
  const cache = new MediaContinuationCache({
    maxBytes: 1_000_000,
    maxBytesPerSession: 1_000_000,
    retentionMs: 100,
    clock: () => now,
  });
  cache.set('session-a', 'one', { block: { type: 'text', text: 'short' } });
  const firstBytes = cache.health().bytes;
  cache.set('session-a', 'one', { block: { type: 'text', text: 'long'.repeat(100) } });
  const replacedBytes = cache.health().bytes;
  assert.ok(replacedBytes > firstBytes);
  assert.equal(cache.health().entries, 1);

  assert.equal(cache.resetSession('session-a'), 1);
  assert.equal(cache.health().bytes, 0);

  cache.set('session-b', 'one', { block: { type: 'text', text: 'expires' } });
  assert.ok(cache.health().bytes > 0);
  now = 101;
  assert.equal(cache.get('session-b', 'one'), null);
  assert.equal(cache.health().bytes, 0);
});

test('V0.29.12 continuation cache refuses a single entry larger than either byte budget', () => {
  const cache = new MediaContinuationCache({ maxBytes: 1, maxBytesPerSession: 1 });
  assert.equal(cache.set('session-a', 'huge', { block: { type: 'text', text: 'not-empty' } }), false);
  assert.deepEqual(cache.health(), {
    sessions: 0,
    entries: 0,
    bytes: 0,
    maxBytes: 1,
    maxBytesPerSession: 1,
  });
});
