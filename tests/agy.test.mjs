import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerJsonl } from '../dist/adapters.js';
import { parseModelOutput, assertServedModel, retryableAgyStartup } from '../dist/planning.js';
import { defaultRouting } from '../dist/routing.js';

const stream = (result = { status: 'SUCCESS', structured_output: { status: 'completed', summary: 'done', question: null }, response: 'narration', usage: { output_tokens: 15 } }) => [
  { event: 'init', init: { model: 'gemini-3.8-flash-high' } },
  { event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: 'untrusted intermediate' } },
  { event: 'result', result },
].map(JSON.stringify).join('\n');

test('agycli event/result envelope uses final structured output and actual model', () => {
  const result = parseWorkerJsonl('agy', stream(), 0);
  assert.equal(result.provider, 'agy');
  assert.equal(result.model, 'gemini-3.8-flash-high');
  assert.equal(JSON.parse(result.summary).summary, 'done');
  assert.equal(result.usage.output_tokens, 15);
  assert.deepEqual(parseModelOutput('agy', stream(), 0).value, { status: 'completed', summary: 'done', question: null });
});

test('agycli rejects incomplete, failed and schema-less results', () => {
  assert.throws(() => parseWorkerJsonl('agy', stream().split('\n').slice(0, 2).join('\n'), 0), /最终结果/);
  assert.throws(() => parseWorkerJsonl('agy', stream({ status: 'ERROR', response: 'failed' }), 0), /失败/);
  assert.throws(() => parseModelOutput('agy', stream({ status: 'SUCCESS', response: '{}' }), 0), /结构化/);
  assert.throws(() => parseWorkerJsonl('agy', stream(), 1), /退出码/);
  assert.throws(() => parseWorkerJsonl('agy', stream({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] }), 0), /权限检查拒绝/);
});

test('missing observed agy model cannot be passed off as the requested model', () => {
  assert.throws(() => assertServedModel(defaultRouting().primary, null), /模型不匹配/);
});

test('only agy startup network failures with no partial session may retry', () => {
  const failure = {code:1,output:'',stderr:'Eligibility check failed: net/http: TLS handshake timeout'};
  assert.equal(retryableAgyStartup(failure),true);
  assert.equal(retryableAgyStartup({...failure,output:'{"event":"init"}'}),false);
  assert.equal(retryableAgyStartup({...failure,stderr:'permission denied'}),false);
});

test('available agy models are the default primary, UI and independent reviewer', () => {
  const route = defaultRouting();
  assert.equal(route.primary.provider, 'agy');
  assert.equal(route.primary.model, 'claude-opus-4-6-thinking');
  assert.equal(route.ui.provider, 'agy');
  assert.equal(route.ui.model, 'gemini-3.8-flash-high');
  assert.equal(route.reviewer.model, route.primary.model);
  assert.equal(route.selection, 'available_models');
  assert.equal(defaultRouting('single', { primary: 'custom-opus' }).reviewer.model, 'custom-opus');
});
