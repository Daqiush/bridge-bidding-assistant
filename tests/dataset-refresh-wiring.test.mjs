import test from 'node:test';
import assert from 'node:assert/strict';
import { changedSystems, nextImportAction, nextImportWindow, sourceVersionFingerprint } from '../worker/dataset/refresh.js';
import worker from '../worker/index.js';

test('refresh advances incomplete systems before activating a generation', () => {
  assert.deepEqual(nextImportAction([
    { system: 'JQA', stage: 'complete' },
    { system: 'CBB', stage: 'import_chunks' },
  ]), { type: 'import', system: 'CBB', stage: 'import_chunks' });
  assert.deepEqual(nextImportAction([
    { system: 'JQA', stage: 'complete' },
    { system: 'CBB', stage: 'complete' },
    { system: 'NBS', stage: 'complete' },
    { system: 'ASY', stage: 'complete' },
  ]), { type: 'activate' });
});

test('imports a bounded 2000-line window without passing EOF', () => {
  assert.deepEqual(nextImportWindow(350, 5000), { start: 350, end: 2350 });
  assert.deepEqual(nextImportWindow(4500, 5000), { start: 4500, end: 5000 });
});

test('uses the four archive version filenames and ignores signed URL query strings', () => {
  assert.equal(sourceVersionFingerprint({
    JQA: 'https://files.example.test/updates/bidproduct_JQA_CN_1.3.2.zip?signature=first',
    CBB: 'https://files.example.test/updates/bidproduct_CBB_CN_1.5.2.zip?signature=second',
    NBS: 'https://files.example.test/updates/bidproduct_NBS_CN_1.1.3.zip?signature=third',
    ASY: 'https://files.example.test/updates/bidproduct_ASY_CN_1.0.1.zip?signature=fourth',
  }), 'ASY:bidproduct_ASY_CN_1.0.1.zip|CBB:bidproduct_CBB_CN_1.5.2.zip|JQA:bidproduct_JQA_CN_1.3.2.zip|NBS:bidproduct_NBS_CN_1.1.3.zip');
});

test('imports only systems whose archive version changed after an initial generation', () => {
  const previous = 'ASY:bidproduct_ASY_CN_1.0.1.zip|CBB:bidproduct_CBB_CN_1.5.2.zip|JQA:bidproduct_JQA_CN_1.3.2.zip|NBS:bidproduct_NBS_CN_1.1.3.zip';
  const current = 'ASY:bidproduct_ASY_CN_1.0.1.zip|CBB:bidproduct_CBB_CN_1.5.3.zip|JQA:bidproduct_JQA_CN_1.3.2.zip|NBS:bidproduct_NBS_CN_1.1.3.zip';
  assert.deepEqual(changedSystems(previous, current), ['CBB']);
  assert.deepEqual(changedSystems(null, current), ['JQA', 'CBB', 'NBS', 'ASY']);
});

test('scheduled refresh defers one refresh burst to the Cloudflare execution context', async () => {
  let deferred;
  await worker.scheduled({}, { DB: {}, STAGING: {} }, { waitUntil(promise) { deferred = promise; } });
  assert.equal(typeof deferred?.then, 'function');
  await deferred;
});
