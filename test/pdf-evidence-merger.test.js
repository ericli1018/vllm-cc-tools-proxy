import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePageEvidence } from '../src/visual/pdf-evidence-merger.js';

test('V0.2.27 page evidence merger deduplicates overlap and preserves source ids', () => {
  const merged = mergePageEvidence({
    page: 42,
    route: 'SCHEMATIC',
    nativeText: 'ETHERNET PHY',
    overview: 'RTL8211F Ethernet section',
    regions: [
      { sourceId: 'asset-2', markdown: '- R109 connects ETH_CLK\n- RESET_N connects GPIOZ3' },
      { sourceId: 'asset-3', markdown: '- R109 connects ETH_CLK\n- VDDIO2 powers PHY' },
    ],
  });
  assert.match(merged, /Page 42/);
  assert.match(merged, /SCHEMATIC/);
  assert.equal((merged.match(/R109 connects ETH_CLK/g) || []).length, 1);
  assert.match(merged, /asset-2/);
  assert.match(merged, /asset-3/);
});

test('V0.2.27 page evidence merger retains uncertainty instead of resolving it', () => {
  const merged = mergePageEvidence({
    page: 7, route: 'SCHEMATIC', overview: '', regions: [
      { sourceId: 'a', markdown: 'R7 appears to be 10k\nUncertain: label may be R1' },
      { sourceId: 'b', markdown: 'R7 appears to be 1k' },
    ],
  });
  assert.match(merged, /10k/);
  assert.match(merged, /1k/);
  assert.match(merged, /Uncertainty/i);
  assert.match(merged, /label may be R1/);
});
