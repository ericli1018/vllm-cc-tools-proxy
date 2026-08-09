import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfPageScope, PdfPageScopeError } from '../src/proxy/pdf-page-scope.js';

test('V0.2.27.2 normalizes a single Read.pages page', () => {
  assert.deepEqual(parsePdfPageScope('42'), { pages: [42], canonical: '42' });
});

test('V0.2.27.2 normalizes ranges, ordering and duplicates deterministically', () => {
  assert.deepEqual(parsePdfPageScope('43, 40-41, 41'), { pages: [40, 41, 43], canonical: '40-41,43' });
});

test('V0.2.27.2 treats absent Read.pages as whole-document scope', () => {
  assert.equal(parsePdfPageScope(undefined), null);
  assert.equal(parsePdfPageScope(''), null);
});

test('V0.2.27.2 rejects malformed and oversized Read.pages scopes', () => {
  assert.throws(() => parsePdfPageScope('4-2'), (error) => error instanceof PdfPageScopeError && error.code === 'invalid_pdf_page_scope');
  assert.throws(() => parsePdfPageScope('x'), (error) => error instanceof PdfPageScopeError && error.code === 'invalid_pdf_page_scope');
  assert.throws(() => parsePdfPageScope('1-101', { maxPages: 100 }), (error) => error instanceof PdfPageScopeError && error.code === 'pdf_page_scope_limit');
});
