import test from 'node:test';
import assert from 'node:assert/strict';
import { providerEnvironment, executable } from '../dist/process.js';
import { parseWorkerJsonl, AdapterError } from '../dist/adapters.js';

test('Codex requires turn.completed and rejects a failed turn', () => {
  const success = [
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'implemented' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } }),
  ].join('\n');
  assert.equal(parseWorkerJsonl('codex', success, 0).summary, 'implemented');
  assert.throws(() => parseWorkerJsonl('codex', JSON.stringify({ type: 'turn.failed' }), 0), /失败/);
  assert.throws(() => parseWorkerJsonl('codex', success, 1), /退出码/);
});

test('malformed and unknown events do not count as success', () => {
  assert.throws(() => parseWorkerJsonl('agy', '{broken', 0), error => error instanceof AdapterError);
  assert.throws(() => parseWorkerJsonl('codex', JSON.stringify({ type: 'future.completed' }), 0), /未知事件/);
});

test('each worker receives its own API credential but not the other providers credentials', () => {
  const old = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.ANTHROPIC_API_KEY = 'anthropic-test';
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.OPENAI_API_KEY = 'openai-test';
  try {
    const gemini = { env: providerEnvironment('agy') };
    const codex = { env: providerEnvironment('codex') };
    assert.equal(gemini.env.GEMINI_API_KEY, undefined);
    assert.equal(gemini.env.OPENAI_API_KEY, undefined);
    assert.equal(codex.env.OPENAI_API_KEY, 'openai-test');
    assert.equal(codex.env.GEMINI_API_KEY, undefined);
    assert.equal(codex.env.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Windows commands resolve to native executables without shell shims', () => {
  if (process.platform === 'win32') {
    assert.match(executable('agy').file, /\.exe$/i);
    assert.match(executable('codex').file, /\.exe$/i);
  }
});
