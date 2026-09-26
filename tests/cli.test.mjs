import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../bin/skillcrew.mjs', import.meta.url));
const invoke = (...args) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8' });

test('init, freeze, and status work through the published command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-cli-'));
  const requestFile = join(root, 'request.json');
  await writeFile(requestFile, '\uFEFF' + JSON.stringify({ request: '做一个待办应用' }));
  const stateDir = join(root, 'state');
  const outputDir = join(root, 'app');
  const inventoryFile = join(root, 'inventory.json');
  await writeFile(inventoryFile, JSON.stringify({ agy: ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high'], codex: ['gpt-6-astra', 'gpt-6-sol'] }));
  const route = invoke('route', '--inventory-file', inventoryFile, '--state-dir', stateDir);
  assert.equal(route.status, 0, route.stderr);
  const created = invoke('init', '--request-file', requestFile, '--out', outputDir, '--state-dir', stateDir, '--inventory-file', inventoryFile);
  assert.equal(created.status, 0, created.stderr);
  const run = JSON.parse(created.stdout);
  assert.equal(run.request, '做一个待办应用');
  assert.equal(run.plan.routing.mode, 'dual');
  assert.deepEqual(run.plan.routing.primary, JSON.parse(route.stdout).primary);
  assert.deepEqual(run.plan.routing.coLead, JSON.parse(route.stdout).coLead);
  for (const model of ['gpt-6-astra', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high', 'gpt-6-sol']) assert.ok(created.stderr.includes(model), model);
  assert.match(run.id, /^[a-f0-9-]{36}$/);
  const planFile = join(root, 'plan.json');
  await writeFile(planFile, JSON.stringify({ summary: '待办应用', acceptanceMapping: {
    'AC-CRUD': '增删改完成', 'AC-CATEGORY': '分类', 'AC-DRAG': '拖拽', 'AC-PERSIST': '保存', 'AC-RECOVER': '恢复',
  } }));
  const planned = invoke('set-plan', run.id, '--file', planFile, '--state-dir', stateDir);
  assert.equal(planned.status, 0, planned.stderr);
  const frozen = invoke('freeze', run.id, '--state-dir', stateDir);
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.equal(JSON.parse(frozen.stdout).status, 'frozen');
  const status = invoke('status', run.id, '--state-dir', stateDir);
  assert.equal(JSON.parse(status.stdout).contractHash.length, 64);
});

test('doctor is local and reports missing capabilities without pretending ready', () => {
  const result = invoke('doctor');
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.ok, 'boolean');
  assert.ok(report.checks.some(check => check.name === 'agy'));
  assert.ok(!report.checks.some(check => ['gemini', 'claude'].includes(check.name)));
});
