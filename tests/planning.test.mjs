import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, loadRun } from '../dist/run-store.js';
import { runPlanning } from '../dist/planning.js';

const mapping = {
  'AC-CRUD': '增删改完成', 'AC-CATEGORY': '分类', 'AC-DRAG': '拖拽',
  'AC-PERSIST': '保存', 'AC-RECOVER': '恢复',
};

test('primary drafts, asks two advisors, and resolves each note before freeze', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-planning-'));
  const stateRoot = join(root, 'state');
  const run = await createRun(stateRoot, '做一个待办应用', join(root, 'app'));
  const calls = [];
  const call = async (route, prompt, phase) => {
    calls.push({ role: route.role, model: route.model, phase, prompt });
    assert.match(prompt, /interface AppViewProps/);
    assert.match(prompt, /不得新增字段/);
    if (phase === 'draft') return { value: { summary: '待办看板', acceptanceMapping: mapping }, observedModel: 'claude-opus-4-6-thinking' };
    if (phase === 'consult' && route.role === 'ui') return { value: { notes: [{ kind: 'question', text: '空分类如何拖入？', acceptanceId: 'AC-DRAG' }] }, observedModel: 'gemini-3.8-flash-high' };
    if (phase === 'consult') return { value: { notes: [{ kind: 'risk', text: '坏数据恢复边界不清', acceptanceId: 'AC-RECOVER' }] }, observedModel: 'gpt-6-sol' };
    return { value: { summary: '待办看板', acceptanceMapping: mapping, decisions: [
      { noteId: 'gemini-1', disposition: 'adopt', reason: '空分类可直接放入' },
      { noteId: 'codex-1', disposition: 'adopt', reason: '坏数据回退到空状态' },
    ] }, observedModel: 'claude-opus-4-6-thinking' };
  };
  const planned = await runPlanning(stateRoot, run.id, { call });
  assert.equal(planned.plan.collaboration.notes.length, 2);
  assert.equal(planned.plan.collaboration.decisions.length, 2);
  assert.deepEqual(calls.map(call => call.phase), ['draft', 'consult', 'consult', 'final']);
  assert.equal(calls[0].model, 'claude-opus-4-6-thinking');
  assert.equal((await loadRun(stateRoot, run.id)).plan.planner.observedModel, 'claude-opus-4-6-thinking');
});

test('dual lead asks Astra for a separate critical opinion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-dual-'));
  const stateRoot = join(root, 'state');
  const run = await createRun(stateRoot, '做一个待办应用', join(root, 'app'), 'dual');
  const calls = [];
  const call = async (route, prompt, phase) => {
    calls.push({ role: route.role, model: route.model, phase });
    if (phase === 'draft') return { value: { summary: '待办', acceptanceMapping: mapping }, observedModel: route.model };
    if (phase === 'consult') return { value: { notes: [] }, observedModel: route.model };
    if (phase === 'co_lead') return { value: { opinion: '明确跨分类拖拽次序' }, observedModel: route.model };
    return { value: { summary: '待办', acceptanceMapping: mapping, decisions: [] }, observedModel: route.model };
  };
  const planned = await runPlanning(stateRoot, run.id, { call });
  assert.equal(planned.plan.collaboration.coLeadOpinion, '明确跨分类拖拽次序');
  assert.ok(calls.some(call => call.phase === 'co_lead' && call.model === 'gpt-6-astra'));
});

test('an unanswered advisor question blocks plan publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-unanswered-'));
  const stateRoot = join(root, 'state');
  const run = await createRun(stateRoot, '做一个待办应用', join(root, 'app'));
  const call = async (route, prompt, phase) => {
    if (phase === 'draft') return { value: { summary: '待办', acceptanceMapping: mapping }, observedModel: route.model };
    if (phase === 'consult' && route.role === 'ui') return { value: { notes: [{ kind: 'question', text: '问题', acceptanceId: null }] }, observedModel: route.model };
    if (phase === 'consult') return { value: { notes: [] }, observedModel: route.model };
    return { value: { summary: '待办', acceptanceMapping: mapping, decisions: [] }, observedModel: route.model };
  };
  await assert.rejects(runPlanning(stateRoot, run.id, { call }), /逐条回应/);
  assert.equal((await loadRun(stateRoot, run.id)).completed.includes('plan'), false);
});

test('default route refuses an observed downgrade of the primary model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-downgrade-'));
  const stateRoot = join(root, 'state');
  const run = await createRun(stateRoot, '做一个待办应用', join(root, 'app'));
  await assert.rejects(runPlanning(stateRoot, run.id, {
    call: async () => ({ value: { summary: '待办', acceptanceMapping: mapping }, observedModel: 'claude-sonnet-5' }),
  }), /模型不匹配/);
});

test('interrupted planning reuses successful draft and peer consultation',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'crew-plan-resume-')),root=join(temp,'state');
  const run=await createRun(root,'做一个待办应用',join(temp,'app'));
  const calls={draft:0,ui:0,logic:0,final:0};
  const call=async(route,prompt,phase)=>{
    const key=phase==='consult'?route.role:phase;calls[key]++;
    assert.match(prompt,/ASSIGNED SKILLS/);
    if(key==='logic'&&calls.logic===1)throw new Error('offline');
    return {observedModel:route.model,value:phase==='consult'?{notes:[]}:{summary:'待办',acceptanceMapping:mapping,decisions:[]}};
  };
  await assert.rejects(runPlanning(root,run.id,{call}),/offline/);
  const result=await runPlanning(root,run.id,{call});
  assert.ok(result.completed.includes('plan'));
  assert.deepEqual(calls,{draft:1,ui:1,logic:2,final:1});
});
