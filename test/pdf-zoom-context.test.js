import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdfZoomContext } from '../src/visual/pdf-zoom-context.js';

test('V0.29.34 builds a bounded page context capsule with overview, native text and adjacent prior evidence', () => {
  const context = buildPdfZoomContext({
    page: 42,
    route: 'SCHEMATIC',
    overview: 'Overview: U15 Ethernet PHY with ETH_CLK and RESET_N crossing the page.',
    nativeText: 'U15 R109 ETH_CLK RESET_N GPIOZ3',
    currentTile: { index: 2, bbox: [450, 0, 1000, 550] },
    priorRegions: [
      { tileIndex: 1, bbox: [0, 0, 550, 550], sourceId: 'tile-1', markdown: '- R109 connects to ETH_CLK near U15.\n- RESET_N exits the right edge.\n- Uncertain: U15 pin number unreadable.' },
      { tileIndex: 9, bbox: [0, 700, 300, 1000], sourceId: 'far-away', markdown: '- FAR_AWAY_NET should not leak into this tile.' },
    ],
    maxChars: 2400,
  });

  assert.match(context, /VCC_PDF_ZOOM_CONTEXT/);
  assert.match(context, /Page 42/);
  assert.match(context, /U15 Ethernet PHY/);
  assert.match(context, /U15 R109 ETH_CLK RESET_N GPIOZ3/);
  assert.match(context, /R109 connects to ETH_CLK/);
  assert.match(context, /RESET_N exits the right edge/);
  assert.match(context, /Uncertain: U15 pin number unreadable/);
  assert.doesNotMatch(context, /FAR_AWAY_NET/);
  assert.match(context, /re-verify/i);
  assert.ok(context.length <= 2400);
});

test('V0.29.34 first tile receives overview/native context without fabricated prior anchors', () => {
  const context = buildPdfZoomContext({
    page: 1,
    route: 'DIAGRAM',
    overview: 'Overview block A points to block B.',
    nativeText: 'BLOCK_A BLOCK_B',
    currentTile: { index: 1, bbox: [0, 0, 550, 550] },
    priorRegions: [],
  });
  assert.match(context, /Overview block A points to block B/);
  assert.match(context, /BLOCK_A BLOCK_B/);
  assert.doesNotMatch(context, /Prior adjacent tile observations:/);
});

test('V0.29.34 capsule remains bounded when prior evidence is very large', () => {
  const context = buildPdfZoomContext({
    page: 7,
    route: 'DENSE_PAGE',
    overview: 'O'.repeat(5000),
    nativeText: 'N'.repeat(5000),
    currentTile: { index: 2, bbox: [450, 0, 1000, 550] },
    priorRegions: [{ tileIndex: 1, bbox: [0, 0, 550, 550], sourceId: 'a', markdown: 'A'.repeat(5000) }],
    maxChars: 1800,
  });
  assert.ok(context.length <= 1800);
});
