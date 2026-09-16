import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VisualRecoveryStore } from '../src/visual/visual-recovery-store.js';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function diskSessionPath(rootDir, sessionId) {
  return path.join(rootDir, 'visual-recovery-v1', 'sessions', sha256(Buffer.from(`session\n${sessionId}`)));
}

async function exists(filename) {
  try {
    await fs.stat(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-recovery-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function source(buffer, overrides = {}) {
  return {
    sourceId: 'source-1',
    imageSha256: sha256(buffer),
    filename: 'screen.png',
    sourceKind: 'tool_result',
    mediaType: 'image/png',
    sourceBuffer: buffer,
    locator: {
      toolName: 'Read',
      input: { file_path: '/client/screen.png' },
      toolUseId: 'read-1'
    },
    provenance: { messageId: 'message-1', contentIndex: 2 },
    ...overrides
  };
}

async function regularFiles(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) output.push(filename);
    }
  }
  await walk(root);
  return output;
}

test('source metadata, evidence, and bytes survive a new store instance', async (t) => {
  const rootDir = await temporaryRoot(t);
  const bytes = Buffer.from('persisted pixels');
  const first = new VisualRecoveryStore({ rootDir });
  await first.initialize();

  const stored = await first.putSource('session-a', source(bytes));
  const evidence = {
    plan: { focus: 'error dialog', steps: ['inspect title', 'read body'] },
    perception: { text: 'Permission denied', confidence: 0.97 },
    intentKey: 'diagnose-error',
    sourceId: 'source-1'
  };
  const evidenced = await first.setEvidence('session-a', stored.assetId, evidence);

  const second = new VisualRecoveryStore({ rootDir });
  await second.initialize();

  assert.deepEqual(await second.getSource('session-a', stored.assetId), {
    assetId: stored.assetId,
    sourceId: 'source-1',
    imageSha256: sha256(bytes),
    filename: 'screen.png',
    sourceKind: 'tool_result',
    mediaType: 'image/png',
    locator: {
      toolName: 'Read',
      input: { file_path: '/client/screen.png' },
      toolUseId: 'read-1'
    },
    provenance: { messageId: 'message-1', contentIndex: 2 },
    updatedAt: evidenced.updatedAt,
    evidence
  });
  assert.deepEqual(await second.getBytes('session-a', stored.assetId), bytes);
  assert.equal('sourceBuffer' in stored, false);
});

test('blob eviction retains stable metadata and reacquisition fields', async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = 10;
  const store = new VisualRecoveryStore({ rootDir, maxBytes: 4, clock: () => now });
  await store.initialize();

  const first = await store.putSource('session-a', source(Buffer.from('1234')));
  now += 1;
  const second = await store.putSource('session-a', source(Buffer.from('5678'), {
    sourceId: 'source-2',
    filename: 'new.png',
    locator: { toolName: 'Screenshot', input: { window: 'main' }, toolUseId: 'shot-2' },
    provenance: { turn: 4 }
  }));

  assert.equal(await store.getBytes('session-a', first.assetId), null);
  assert.deepEqual(await store.getBytes('session-a', second.assetId), Buffer.from('5678'));
  assert.deepEqual(await store.getSource('session-a', first.assetId), first);
  assert.deepEqual((await store.getSource('session-a', second.assetId)).locator, {
    toolName: 'Screenshot', input: { window: 'main' }, toolUseId: 'shot-2'
  });
});

test('putSource rejects a claimed hash that does not match the source bytes', async () => {
  const store = new VisualRecoveryStore();
  await store.initialize();

  await assert.rejects(
    store.putSource('session-a', source(Buffer.from('real'), { imageSha256: '0'.repeat(64) })),
    /sha-?256|hash/i
  );
  assert.deepEqual(await store.listSources('session-a'), []);
});

test('corrupt blob bytes are rejected without deleting their metadata', async (t) => {
  const rootDir = await temporaryRoot(t);
  const bytes = Buffer.from('trusted pixels');
  const store = new VisualRecoveryStore({ rootDir });
  await store.initialize();
  const saved = await store.putSource('session-a', source(bytes));

  const files = await regularFiles(rootDir);
  const blob = files.find((filename) => filename.endsWith('.blob'));
  assert.ok(blob, 'a separately stored blob must exist');
  await fs.writeFile(blob, 'tampered');

  const restarted = new VisualRecoveryStore({ rootDir });
  await restarted.initialize();
  assert.equal(await restarted.getBytes('session-a', saved.assetId), null);
  assert.deepEqual(await restarted.getSource('session-a', saved.assetId), saved);
});

test('asset IDs are scoped to a session and malformed external IDs are inert', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new VisualRecoveryStore({ rootDir });
  await store.initialize();
  const bytes = Buffer.from('same image');
  const a = await store.putSource('session-a', source(bytes));
  const b = await store.putSource('session-b', source(bytes));

  assert.notEqual(a.assetId, b.assetId);
  assert.equal(await store.getSource('session-b', a.assetId), null);
  assert.equal(await store.getBytes('session-a', '../../outside'), null);
  assert.equal(await store.getRecovery('session-a', '../../outside'), null);
  assert.equal(await store.setEvidence('session-a', '../../outside', { perception: 'x' }), null);
  assert.deepEqual(await store.listSources('session-a'), [a]);

  const requestLocal = new VisualRecoveryStore({ rootDir });
  await requestLocal.initialize();
  const anonymous = await requestLocal.putSource('', source(Buffer.from('request local')));
  assert.ok(await requestLocal.getSource('', anonymous.assetId));
  const nextRequest = new VisualRecoveryStore({ rootDir });
  await nextRequest.initialize();
  assert.equal(await nextRequest.getSource('', anonymous.assetId), null);
});

test('pending recovery state and caller JSON survive restart and upsert', async (t) => {
  const rootDir = await temporaryRoot(t);
  const first = new VisualRecoveryStore({ rootDir });
  await first.initialize();
  const recovery = {
    id: 'recovery/one',
    assetIds: ['asset-placeholder'],
    sourceHints: [{ sourceId: 'source-1', locator: { toolName: 'Read' } }],
    intentKey: 'inspect-dialog',
    attempts: 1,
    status: 'pending',
    toolCalls: [{ toolUseId: 'tool-1', state: 'requested' }],
    plan: { target: 'dialog body' },
    customCoordinatorField: { preserve: true }
  };
  assert.deepEqual(await first.saveRecovery('session-a', recovery), recovery);

  const second = new VisualRecoveryStore({ rootDir });
  await second.initialize();
  assert.deepEqual(await second.getRecovery('session-a', 'recovery/one'), recovery);

  const updated = { ...recovery, attempts: 2, status: 'complete', toolCalls: [...recovery.toolCalls, { toolUseId: 'tool-2', state: 'received' }] };
  assert.deepEqual(await second.saveRecovery('session-a', updated), updated);
  assert.deepEqual(await second.listRecoveries('session-a'), [updated]);
  assert.equal(await second.getRecovery('session-b', 'recovery/one'), null);
});

test('serialized concurrent writes do not lose source records or evidence', async () => {
  let now = 100;
  const store = new VisualRecoveryStore({ maxEntries: 64, clock: () => ++now });
  await store.initialize();
  const inputs = Array.from({ length: 24 }, (_, index) => source(Buffer.from(`pixels-${index}`), {
    sourceId: `source-${index}`,
    filename: `${index}.png`,
    locator: { toolName: 'Read', input: { file_path: `/client/${index}.png` }, toolUseId: `read-${index}` },
    provenance: { index }
  }));

  const records = await Promise.all(inputs.map((input) => store.putSource('session-a', input)));
  await Promise.all(records.map((record, index) => store.setEvidence('session-a', record.assetId, {
    plan: { index }, perception: { index }, intentKey: `intent-${index}`, sourceId: `source-${index}`
  })));

  const listed = await store.listSources('session-a');
  assert.equal(listed.length, 24);
  assert.deepEqual(new Set(listed.map((entry) => entry.assetId)), new Set(records.map((entry) => entry.assetId)));
  for (const [index, record] of records.entries()) {
    assert.deepEqual((await store.getSource('session-a', record.assetId)).evidence, {
      plan: { index }, perception: { index }, intentKey: `intent-${index}`, sourceId: `source-${index}`
    });
  }
});

test('TTL cleanup prunes expired source metadata, blobs, and recoveries', async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = 1_000;
  const first = new VisualRecoveryStore({ rootDir, retentionMs: 100, clock: () => now });
  await first.initialize();
  const saved = await first.putSource('session-a', source(Buffer.from('expires')));
  await first.saveRecovery('session-a', {
    id: 'expired-recovery', assetIds: [saved.assetId], sourceHints: [], intentKey: 'old', attempts: 1, status: 'pending', toolCalls: []
  });

  now += 101;
  const second = new VisualRecoveryStore({ rootDir, retentionMs: 100, clock: () => now });
  await second.initialize();
  assert.equal(await second.getSource('session-a', saved.assetId), null);
  assert.equal(await second.getBytes('session-a', saved.assetId), null);
  assert.equal(await second.getRecovery('session-a', 'expired-recovery'), null);
  assert.deepEqual(await second.listSources('session-a'), []);
  assert.deepEqual(await second.listRecoveries('session-a'), []);
});

test('memory mode bounds metadata entries and blob bytes while keeping surviving metadata', async () => {
  let now = 1;
  const store = new VisualRecoveryStore({ maxEntries: 2, maxBytes: 3, clock: () => now });
  await store.initialize();
  const first = await store.putSource('session-a', source(Buffer.from('111')));
  now += 1;
  const second = await store.putSource('session-a', source(Buffer.from('222'), { sourceId: 'source-2' }));
  now += 1;
  const third = await store.putSource('session-a', source(Buffer.from('333'), { sourceId: 'source-3' }));

  assert.deepEqual((await store.listSources('session-a')).map((entry) => entry.assetId), [third.assetId, second.assetId]);
  assert.equal(await store.getSource('session-a', first.assetId), null);
  assert.equal(await store.getBytes('session-a', second.assetId), null);
  assert.deepEqual(await store.getBytes('session-a', third.assetId), Buffer.from('333'));
  assert.ok(await store.getSource('session-a', second.assetId), 'blob eviction must leave source metadata intact');
});

test('oversized metadata is rejected instead of growing the store without bound', async () => {
  const store = new VisualRecoveryStore();
  await store.initialize();
  const tooLarge = 'x'.repeat(256 * 1024);

  await assert.rejects(
    store.putSource('session-a', source(Buffer.from('small'), { provenance: { tooLarge } })),
    /metadata|large|256/i
  );
  await assert.rejects(
    store.saveRecovery('session-a', {
      id: 'large', assetIds: [], sourceHints: [], intentKey: 'large', attempts: 0, status: 'pending', toolCalls: [], tooLarge
    }),
    /metadata|large|256/i
  );
});

test('restart ignores and removes structurally malformed source and recovery records', async (t) => {
  const rootDir = await temporaryRoot(t);
  const first = new VisualRecoveryStore({ rootDir });
  await first.initialize();
  const stored = await first.putSource('session-a', source(Buffer.from('restart validation')));
  await first.saveRecovery('session-a', {
    id: 'recovery-a',
    assetIds: [stored.assetId],
    sourceHints: [{ sourceId: 'source-1' }],
    intentKey: 'inspect',
    attempts: 1,
    status: 'pending',
    toolCalls: []
  });

  const sessionDir = diskSessionPath(rootDir, 'session-a');
  const sourceFile = path.join(sessionDir, 'sources', `${stored.assetId}.json`);
  const recoveryFile = path.join(sessionDir, 'recoveries', `${sha256(Buffer.from('recovery\nrecovery-a'))}.json`);
  const badSource = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  delete badSource.value.locator;
  badSource.value.sourceBuffer = 'forbidden persisted bytes';
  badSource.value.updatedAt = String(badSource.value.updatedAt);
  await fs.writeFile(sourceFile, JSON.stringify(badSource));
  const badRecovery = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
  badRecovery.value.attempts = '1';
  delete badRecovery.value.toolCalls;
  await fs.writeFile(recoveryFile, JSON.stringify(badRecovery));

  const restarted = new VisualRecoveryStore({ rootDir });
  await restarted.initialize();
  assert.deepEqual(await restarted.listSources('session-a'), []);
  assert.deepEqual(await restarted.listRecoveries('session-a'), []);
  assert.equal(await exists(sourceFile), false);
  assert.equal(await exists(recoveryFile), false);
});

test('disk cleanup removes bounded-store debris and empty hashed session directories only', async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = 1;
  const store = new VisualRecoveryStore({ rootDir, maxEntries: 1, clock: () => now });
  await store.initialize();
  let survivor;
  for (let index = 0; index < 9; index += 1) {
    now += 1;
    survivor = await store.putSource(`session-${index}`, source(Buffer.from(`image-${index}`), {
      sourceId: `source-${index}`,
      filename: `${index}.png`
    }));
  }

  const sessionsDir = path.join(rootDir, 'visual-recovery-v1', 'sessions');
  const sessionDirs = (await fs.readdir(sessionsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(sessionDirs.length, 1, 'entry pruning must remove empty per-session directories');

  const survivorDir = diskSessionPath(rootDir, 'session-8');
  const sourcesDir = path.join(survivorDir, 'sources');
  const recoveriesDir = path.join(survivorDir, 'recoveries');
  await fs.mkdir(recoveriesDir, { recursive: true });
  const debris = [
    path.join(sourcesDir, 'corrupt.json'),
    path.join(sourcesDir, 'oversized.json'),
    path.join(sourcesDir, `${survivor.assetId}.json.tmp-interrupted`),
    path.join(recoveriesDir, 'unexpected.txt')
  ];
  await fs.writeFile(debris[0], '{bad json');
  await fs.writeFile(debris[1], 'x'.repeat(256 * 1024 + 1));
  await fs.writeFile(debris[2], 'temporary');
  await fs.writeFile(debris[3], 'unexpected');

  const outsideSentinel = path.join(rootDir, 'outside-sentinel.txt');
  await fs.writeFile(outsideSentinel, 'keep');
  const invalidDirectory = path.join(sessionsDir, 'not-a-session-hash');
  const invalidSentinel = path.join(invalidDirectory, 'keep.txt');
  await fs.mkdir(invalidDirectory, { recursive: true });
  await fs.writeFile(invalidSentinel, 'keep');

  const mismatchedDirectory = path.join(sessionsDir, 'f'.repeat(64));
  const mismatchedSources = path.join(mismatchedDirectory, 'sources');
  await fs.mkdir(mismatchedSources, { recursive: true });
  const mismatchedFile = path.join(mismatchedSources, `${survivor.assetId}.json`);
  await fs.copyFile(path.join(sourcesDir, `${survivor.assetId}.json`), mismatchedFile);

  const restarted = new VisualRecoveryStore({ rootDir, maxEntries: 1, clock: () => now });
  await restarted.initialize();
  for (const filename of debris) assert.equal(await exists(filename), false, `${filename} must be cleaned`);
  assert.equal(await exists(mismatchedDirectory), false, 'a hashed directory containing mismatched metadata must be removed');
  assert.equal(await fs.readFile(outsideSentinel, 'utf8'), 'keep');
  assert.equal(await fs.readFile(invalidSentinel, 'utf8'), 'keep');
  assert.deepEqual((await restarted.listSources('session-8')).map((entry) => entry.assetId), [survivor.assetId]);
});

test('metadata commit failure rolls back a newly installed orphan blob', async (t) => {
  const rootDir = await temporaryRoot(t);
  const bytes = Buffer.from('orphan candidate');
  const probe = new VisualRecoveryStore();
  await probe.initialize();
  const { assetId } = await probe.putSource('session-a', source(bytes));

  const sessionDir = diskSessionPath(rootDir, 'session-a');
  const metadataTarget = path.join(sessionDir, 'sources', `${assetId}.json`);
  const blobTarget = path.join(sessionDir, 'blobs', `${assetId}.blob`);
  const store = new VisualRecoveryStore({ rootDir, maxBytes: bytes.byteLength });
  await store.initialize();
  await fs.mkdir(metadataTarget, { recursive: true });

  await assert.rejects(store.putSource('session-a', source(bytes)));
  assert.equal(await exists(blobTarget), false, 'failed metadata commit must not leave an untracked blob');
  assert.deepEqual(await store.listSources('session-a'), []);
});

test('direct uploads without a recoverable frontend locator remain valid durable sources', async () => {
  const rootDir=await fs.mkdtemp(path.join(os.tmpdir(),'vcc-source-no-locator-'));
  try {
    const store=new VisualRecoveryStore({rootDir});
    const source=await store.putSource('direct-upload',{sourceId:'img_01',sourceBuffer:Buffer.from('direct bytes'),filename:'image.png',mediaType:'image/png',sourceKind:'direct_image',locator:null,provenance:null});
    const restarted=new VisualRecoveryStore({rootDir});
    assert.equal((await restarted.getSource('direct-upload',source.assetId)).locator,null);
    assert.equal((await restarted.getBytes('direct-upload',source.assetId)).toString(),'direct bytes');
  } finally {await fs.rm(rootDir,{recursive:true,force:true});}
});
