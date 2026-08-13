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
