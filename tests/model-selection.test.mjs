import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CATALOG, selectRouting } from '../dist/model-catalog.js';
import { createRun } from '../dist/run-store.js';
import { runPlanning } from '../dist/planning.js';
import { renderReport } from '../dist/report.js';

const inventory = { agy: ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high'], codex: ['gpt-6-astra', 'gpt-6-sol'] };

test('automatic selection gives two distinct leaders and suitable implementation workers', () => {
  const routing = selectRouting(DEFAULT_CATALOG, inventory);
  assert.equal(routing.mode, 'dual');
  assert.equal(routing.requestedMode, 'auto');
  assert.equal(routing.primary.model, 'gpt-6-astra');
  assert.equal(routing.coLead.model, 'claude-opus-4-6-thinking');
  assert.equal(routing.ui.model, 'gemini-3.8-flash-high');
  assert.equal(routing.logic.model, 'gpt-6-sol');
});

test('automatic mode explains a single-leader fallback but explicit dual cannot silently fall back', () => {
  const oneLeader = { agy: inventory.agy, codex: [] };
  const routing = selectRouting(DEFAULT_CATALOG, oneLeader);
  assert.equal(routing.mode, 'single');
  assert.equal(routing.coLead, null);
  assert.ok(routing.notices.some(message => /单主模型/.test(message)));
  assert.throws(() => selectRouting(DEFAULT_CATALOG, oneLeader, 'dual'), /co_lead.*没有可用/);
  assert.throws(() => selectRouting(DEFAULT_CATALOG, oneLeader, 'auto', { coLead: 'codex/gpt-6-astra' }), /指定模型不可用/);
});

test('manual leader choices are respected and contradictory choices are rejected', () => {
  const manual = selectRouting(DEFAULT_CATALOG, inventory, 'auto', { primary: 'agy/claude-opus-4-6-thinking' });
  assert.equal(manual.primary.model, 'claude-opus-4-6-thinking');
  assert.equal(manual.coLead.model, 'gpt-6-astra');
  const reserved = selectRouting(DEFAULT_CATALOG, inventory, 'auto', { coLead: 'codex/gpt-6-astra' });
  assert.equal(reserved.coLead.model, 'gpt-6-astra');
  assert.equal(reserved.primary.model, 'claude-opus-4-6-thinking');
  assert.equal(selectRouting(DEFAULT_CATALOG, inventory, 'single').coLead, null);
  assert.throws(() => selectRouting(DEFAULT_CATALOG, inventory, 'single', { coLead: 'codex/gpt-6-astra' }), /single.*co-lead-model/);
  assert.throws(() => selectRouting(DEFAULT_CATALOG, inventory, 'dual', { primary: 'codex/gpt-6-astra', coLead: 'codex/gpt-6-astra' }), /指定模型不可用/);
});

test('a feasible leader pair is used even when the highest primary score has no eligible partner', () => {
  const catalog = { schemaVersion: 1, models: [
    { provider: 'codex', model: 'leader-a', roles: { primary: 100, co_lead: 100, review: 100 } },
    { provider: 'agy', model: 'leader-b', roles: { primary: 90, ui: 100, logic: 100 } },
  ] };
  const available = { codex: ['leader-a'], agy: ['leader-b'] };
  for (const mode of ['auto', 'dual']) {
    const routing = selectRouting(catalog, available, mode);
    assert.equal(routing.mode, 'dual');
    assert.equal(routing.primary.model, 'leader-b');
    assert.equal(routing.coLead.model, 'leader-a');
  }
  // An explicit primary selection takes precedence over finding a different pair.
  const manual = selectRouting(catalog, available, 'auto', { primary: 'codex/leader-a' });
  assert.equal(manual.primary.model, 'leader-a');
  assert.equal(manual.mode, 'single');
});

test('one model exposed by two providers cannot count as two distinct leaders', () => {
  const catalog = { schemaVersion: 1, models: [
    { provider: 'codex', model: 'same-model', roles: { primary: 100, co_lead: 100, review: 100 } },
    { provider: 'agy', model: 'same-model', roles: { primary: 90, co_lead: 90, ui: 100, logic: 100 } },
  ] };
  const available = { codex: ['same-model'], agy: ['same-model'] };
  assert.equal(selectRouting(catalog, available).mode, 'single');
  assert.throws(() => selectRouting(catalog, available, 'dual'), /co_lead.*没有可用/);
  assert.throws(() => selectRouting(catalog, available, 'auto', { primary: 'codex/same-model', coLead: 'agy/same-model' }), /指定模型不可用/);
});

test('report worker labels remain accurate when UI and logic swap providers', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'crew-report-roles-'));
  const routing = selectRouting(DEFAULT_CATALOG, inventory, 'auto', { ui: 'codex/gpt-6-sol', logic: 'agy/claude-opus-4-6-thinking' });
  const state = await createRun(join(temp, 'state'), '做一个待办应用', join(temp, 'app'), routing.mode, {}, { routing });
  state.workerResults = {
    gemini: { status: 'accepted', provider: 'codex', requestedModel: 'gpt-6-sol', model: null, changes: [] },
    codex: { status: 'accepted', provider: 'agy', requestedModel: 'claude-opus-4-6-thinking', model: 'claude-opus-4-6-thinking', changes: [] },
  };
  const report = renderReport(state);
  assert.match(report, /\| UI \| accepted \| gpt-6-sol/);
  assert.match(report, /\| 逻辑 \| accepted \| claude-opus-4-6-thinking/);
});

test('default selected co-leader participates in planning and assignments appear in the report', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'crew-auto-leads-')), root = join(temp, 'state');
  const routing = selectRouting(DEFAULT_CATALOG, inventory);
  const state = await createRun(root, '做一个待办应用', join(temp, 'app'), routing.mode, {}, { routing });
  const mapping = { 'AC-CRUD': '增删改完成', 'AC-CATEGORY': '分类', 'AC-DRAG': '跨分类拖拽', 'AC-PERSIST': '保存', 'AC-RECOVER': '坏数据恢复' };
  const planned = await runPlanning(root, state.id, { call: async (route, prompt, phase) => {
    if (phase === 'consult') return { value: { notes: [] }, observedModel: route.model };
    if (phase === 'co_lead') return { value: { opinion: '跨分类移动需要保留任务 ID。' }, observedModel: route.model };
    if (phase === 'final') assert.match(prompt, /跨分类移动需要保留任务 ID/);
    return { value: { summary: '待办', acceptanceMapping: mapping, decisions: [] }, observedModel: route.model };
  } });
  assert.equal(planned.plan.collaboration.coLeadOpinion, '跨分类移动需要保留任务 ID。');
  assert.ok(planned.plan.collaboration.calls.some(call => call.role === 'co_lead' && call.requestedModel === 'claude-opus-4-6-thinking'));
  const report = renderReport(planned);
  for (const model of ['gpt-6-astra', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high', 'gpt-6-sol']) assert.ok(report.includes(model), model);
});
