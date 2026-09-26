import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCheck, localCheckEnvironment, verificationMode } from '../dist/verify.js';

test('unit check requires all six frozen tests', () => {
  const passing = evaluateCheck('unit', 'Test Files  1 passed\nTests  6 passed (6)', 0, 6);
  assert.equal(passing.passed, true);
  assert.equal(passing.count, 6);
  assert.equal(evaluateCheck('unit', 'Tests  0 passed (0)', 0, 6).passed, false);
  assert.equal(evaluateCheck('unit', 'Tests  5 passed (5)', 0, 6).passed, false);
});

test('local verification is explicit and does not inherit model API credentials', () => {
  assert.equal(verificationMode(), 'docker');
  assert.equal(verificationMode('local'), 'local');
  assert.throws(() => verificationMode('automatic'), /只支持/);
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'should-not-reach-tests';
  try { assert.equal(localCheckEnvironment().OPENAI_API_KEY, undefined); }
  finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test('browser check requires two executed tests', () => {
  assert.equal(evaluateCheck('browser', '  2 passed (4.2s)', 0, 2).passed, true);
  assert.equal(evaluateCheck('browser', 'No tests found', 0, 2).passed, false);
  assert.equal(evaluateCheck('browser', '  2 passed (4.2s)', 1, 2).passed, false);
});
