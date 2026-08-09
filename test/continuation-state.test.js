import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractModelWorkingState,
  planContinuationState,
  mergeCompressedContinuationState,
} from '../src/proxy/continuation-state.js';

function makeResponse(content) {
  return { content };
}

test('V0.2.28.5 extracts only model thinking and visible text blocks', () => {
  const state = extractModelWorkingState(makeResponse([
    { type: 'thinking', thinking: 'reasoning-alpha' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/secret/tool-path' } },
    { type: 'text', text: 'unfinished-visible-beta' },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'tool-secret-query' } },
  ]));
  assert.match(state, /reasoning-alpha/);
  assert.match(state, /unfinished-visible-beta/);
  assert.doesNotMatch(state, /secret\/tool-path|tool-secret-query|Read|web_search/);
});

test('V0.2.28.5 SMALL continuation state is fully preserved', () => {
  const candidate = `begin-${'a'.repeat(1000)}-end`;
  const plan = planContinuationState(candidate);
  assert.equal(plan.mode, 'small');
  assert.equal(plan.fallbackText, candidate);
  assert.equal(plan.windows.length, 0);
});

test('V0.2.28.5 MEDIUM continuation state uses deterministic head plus tail', () => {
  const candidate = `HEAD-${'m'.repeat(50000)}-TAIL`;
  const plan = planContinuationState(candidate);
  assert.equal(plan.mode, 'medium');
  assert.equal(plan.windows.length, 0);
  assert.match(plan.fallbackText, /^HEAD-/);
  assert.match(plan.fallbackText, /earlier model working state omitted/);
  assert.match(plan.fallbackText, /-TAIL$/);
  assert.ok(plan.fallbackText.length < 26000);
});

test('V0.2.28.5 LARGE continuation state creates overlapping 24K windows with 4K overlap', () => {
  const candidate = 'x'.repeat(100000);
  const plan = planContinuationState(candidate);
  assert.equal(plan.mode, 'large');
  assert.ok(plan.windows.length >= 5);
  assert.equal(plan.windows[0].contextStart, 0);
  assert.equal(plan.windows[0].contextEnd, 24000);
  assert.equal(plan.windows[1].contextStart, 20000);
  assert.equal(plan.windows[1].contextEnd, 44000);
  assert.equal(plan.windows[0].text.length, 24000);
  assert.equal(plan.windows[1].text.length, 24000);
  assert.match(plan.fallbackText, /earlier model working state omitted/);
});

test('V0.2.28.5 merge deduplicates overlap-derived state and retains recent raw model tail', () => {
  const merged = mergeCompressedContinuationState([
    {
      working_assumptions: ['Need pure C only.'],
      decisions_considered: ['Use one terminal game loop.'],
      rejected_options: ['Do not use ncurses.'],
      unresolved_items: [],
      intended_next_actions: ['Create main.c.'],
    },
    {
      working_assumptions: [' Need   pure C only. '],
      decisions_considered: ['Use one terminal game loop.'],
      rejected_options: [],
      unresolved_items: ['Ghost movement still undecided.'],
      intended_next_actions: ['Create main.c.'],
    },
  ], 'RECENT-RAW-TAIL');
  assert.equal(merged.deduplicatedItems, 3);
  assert.equal((merged.text.match(/Need pure C only/g) || []).length, 1);
  assert.equal((merged.text.match(/Create main\.c/g) || []).length, 1);
  assert.match(merged.text, /RECENT-RAW-TAIL/);
  assert.match(merged.text, /Compressed historical model working state/);
});
