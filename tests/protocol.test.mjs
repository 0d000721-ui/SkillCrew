import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, freezePlan, assertContractHash, readyStages } from '../dist/protocol.js';

test('supported todo brief maps to a fixed project and full acceptance set', () => {
  const plan = parseRequest('做一个支持拖拽、分类和本地保存的待办应用');
  assert.equal(plan.projectType, 'react-todo');
  assert.deepEqual(plan.acceptanceIds, ['AC-CRUD', 'AC-CATEGORY', 'AC-DRAG', 'AC-PERSIST', 'AC-RECOVER']);
});

test('unsupported scope is rejected instead of silently omitted', () => {
  assert.throws(() => parseRequest('做一个电商支付网站'), /只支持.*待办/);
  assert.throws(() => parseRequest('做一个带账号登录的待办应用'), /账号登录/);
});

test('contract hash changes if frozen behavior changes', () => {
  const plan = parseRequest('做一个待办应用');
  plan.summary = '本地待办';
  plan.acceptanceMapping = Object.fromEntries(plan.acceptanceIds.map(id => [id, `满足 ${id}`]));
  const frozen = freezePlan(plan, { version: 1, move: 'before target' }, 'template-hash');
  assert.doesNotThrow(() => assertContractHash(frozen, plan, { version: 1, move: 'before target' }, 'template-hash'));
  assert.throws(() => assertContractHash(frozen, plan, { version: 1, move: 'after target' }, 'template-hash'), /接口哈希/);
});

test('workers are not ready before freeze, then both become ready', () => {
  assert.deepEqual(readyStages(['plan']), ['freeze']);
  assert.deepEqual(readyStages(['plan', 'freeze']), ['ui', 'logic']);
  assert.deepEqual(readyStages(['plan', 'freeze', 'ui']), ['logic']);
  assert.deepEqual(readyStages(['plan', 'freeze', 'ui', 'logic']), ['integrate']);
});
