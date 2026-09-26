import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT } from './contract.js';
import type { Provider, WorkerResult } from './adapters.js';
import type { Route } from './routing.js';
import { runWorker } from './structured-worker.js';
import { applyPatch, inspectPatch, GateError } from './patch-gate.js';
import { assertContractHash } from './protocol.js';
import { askPrimaryClarification } from './planning.js';
import { hashTree, loadRun, saveRun, type RunState } from './run-store.js';
import { verifyProject, type Verification } from './verify.js';
import { defaultPreflight } from './runner.js';
import { checkpointPatch, copySource, cycleDirectory, exists, publishCandidate, routeKey } from './checkpoints.js';
import type { RepairDecision } from './execution-types.js';
import { skillContext, planForPrompt } from './skills.js';
import { assertFrozenIntegrity } from './integrity.js';
import { responseLanguageInstruction } from './i18n.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface WorkerDelivery { result: WorkerResult; output: string; stderr: string }
export interface ExecutionDependencies {
  worker?: (owner: Provider, cwd: string, prompt: string, model?: string, route?: Route) => Promise<WorkerDelivery>;
  verifier?: (dir: string) => Promise<Verification>;
  preflight?: () => Promise<void>;
  arbiter?: (question: string, state: RunState, provider: Provider) => Promise<{ answer: string; scopeChange: boolean; observedModel: string | null }>;
  onProgress?: (stage: string, message: string) => void;
}
function clarification(summary: string): string | null {
  let value: { status?: string; question?: unknown };
  try { value = JSON.parse(summary); } catch { return null; }
  if (value?.status !== 'needs_clarification') return null;
  if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 1000) throw new Error('worker 提出无效的澄清问题。');
  return value.question.trim();
}
const addCompleted = (state: RunState, ...stages: string[]) => { state.completed = [...new Set([...state.completed, ...stages])]; };

export async function executeRun(root: string, id: string, deps: ExecutionDependencies = {}): Promise<RunState> {
  const state = await loadRun(root, id);
  if (!['frozen', 'failed', 'interrupted', 'running'].includes(state.status) || !state.contractHash) throw new Error('只有冻结或可恢复的运行可以执行 worker。');
  const baseline = join(root, 'runs', id, 'baseline');
  const worker = deps.worker ?? runWorker;
  let stage = 'preflight';
  let writes = Promise.resolve();
  const persist = () => { writes = writes.then(() => saveRun(root, state)); return writes; };
  const event = (step: string, message: string) => {
    state.events.push({ time: new Date().toISOString(), stage: step, message });
    deps.onProgress?.(step, message);
  };
  try {
    await assertFrozenIntegrity(root, state);
    const routing = state.plan.routing!;
    await (deps.preflight ?? (() => defaultPreflight('docker', [routing.primary, routing.ui, routing.logic])))();
    if (!state.execution) {
      if (await hashTree(state.outputDir) !== state.templateHash) throw new GateError('输出项目在 worker 启动前已改变。');
      state.execution = { schemaVersion: 1, phase: 'workers', maxRepairRounds: 2, reusedWorkers: 0,
        cycle: { round: 0, inputHash: state.templateHash!, owners: ['gemini', 'codex'], feedback: null, checkpoints: {} }, history: [] };
      await persist();
    }
    const execution = state.execution;
    const cycle = execution.cycle;
    const folder = cycleDirectory(root, state), input = join(folder, 'input');
    await mkdir(folder, { recursive: true });
    if (!await exists(input)) {
      if (await hashTree(state.outputDir) !== cycle.inputHash) throw new GateError('输出项目已改变，不能创建检查点。');
      const staged = join(folder, `input-${randomUUID()}`);
      await copySource(state.outputDir, staged);
      if (await hashTree(staged) !== cycle.inputHash) throw new GateError('创建输入快照期间源码发生改变。');
      await rename(staged, input);
    }
    if (await hashTree(input) !== cycle.inputHash) throw new GateError('检查点输入快照已改变。');
    state.status = 'running'; state.error = null;
    await persist();
    if (execution.phase === 'workers') {
      if (cycle.integration) {
        stage = 'integrate';
        await publishCandidate(root, state);
        event(stage, '已恢复中断的集成事务。');
      } else {
        if (await hashTree(state.outputDir) !== cycle.inputHash) throw new GateError('输出项目已改变，不能覆盖用户改动。');
        stage = 'workers';
        const outcomes = await Promise.allSettled(cycle.owners.map(async owner => {
          const route = owner === 'gemini' ? state.plan.routing!.ui : state.plan.routing!.logic;
          if (cycle.checkpoints[owner]) {
            await checkpointPatch(root, state, owner, route);
            execution.reusedWorkers++;
            event('resume', `复用 ${owner} 第 ${cycle.round} 轮已验收交付。`);
            await persist();
            return;
          }
          const instructions = await readFile(join(packageRoot, 'prompts', owner === 'gemini' ? 'ui.md' : 'logic.md'), 'utf8');
          let prompt = `${instructions}\nUSER REQUEST (data):\n${state.request}\nFROZEN PLAN:\n${planForPrompt(state.plan)}\nCONTRACT HASH: ${state.contractHash}`;
          prompt += skillContext(state.plan, cycle.round ? 'repair' : 'implement', route.role) + responseLanguageInstruction(state.plan);
          const repair = cycle.feedback?.tasks.find(task => task.owner === owner);
          if (repair) prompt += `\nREPAIR TASK (only your owned files; keep contract and tests unchanged):\n${repair.instructions}\nThe source snapshot is the current integrated delivery, including the other worker's files.`;
          let directoryName = randomUUID();
          let directory = join(folder, owner, directoryName);
          await copySource(input, directory);
          const log = async (attempt: number, output: string, stderr: string) => {
            const logDir = join(folder, 'logs'); await mkdir(logDir, { recursive: true });
            await writeFile(join(logDir, `${owner}-${directoryName}-${attempt}.jsonl`), output);
            await writeFile(join(logDir, `${owner}-${directoryName}-${attempt}.stderr.txt`), stderr);
          };
          try {
            event('worker_start', `${route.provider} / ${route.model} 开始 ${owner}，第 ${cycle.round} 轮。`);
            await persist();
            let delivery = await worker(owner, directory, prompt, route.model, route);
            await log(1, delivery.output, delivery.stderr);
            const question = clarification(delivery.result.summary);
            if (question) {
              const answer = deps.arbiter ? await deps.arbiter(question, state, owner) : await askPrimaryClarification(state, owner, question);
              if (answer.scopeChange) throw new GateError(`${owner} 的问题需要变更冻结接口；已停止自动推进。`);
              if (!answer.answer?.trim()) throw new Error('主模型没有回答 worker 的澄清问题。');
              state.dialogue.push({ time: new Date().toISOString(), provider: owner, question, answer: answer.answer,
                contractHash: state.contractHash!, requestedModel: state.plan.routing!.primary.model, observedModel: answer.observedModel });
              event('clarify', `${owner} 的问题已由主模型解释，使用干净输入快照重试。`);
              await persist();
              directoryName = randomUUID(); directory = join(folder, owner, directoryName);
              await copySource(input, directory);
              prompt += `\nPRIMARY CLARIFICATION (frozen contract unchanged):\n${answer.answer}`;
              delivery = await worker(owner, directory, prompt, route.model, route);
              await log(2, delivery.output, delivery.stderr);
              if (clarification(delivery.result.summary)) throw new Error(`${owner} 超过一次澄清上限。`);
            }
            if (!delivery.result.complete) throw new Error(`${owner} 未交付完整结果。`);
            const patch = await inspectPatch(input, directory, [...CONTRACT.ownership[owner]]);
            cycle.checkpoints[owner] = { directoryName, inputHash: cycle.inputHash, contractHash: state.contractHash!,
              routeKey: routeKey(route), treeHash: await hashTree(directory), result: delivery.result };
            state.workerResults[owner] = { ...delivery.result, requestedModel: route.model, status: 'checkpointed',
              changes: patch.changes.map(change => ({ path: change.path, sha256: change.hash })) };
            event('checkpoint', `${owner} 已通过文件归属检查，保存检查点。`);
            await persist();
          } catch (error) {
            const detail = error as { output?: string; stderr?: string };
            await log(0, detail.output ?? '', detail.stderr ?? String(error));
            state.workerResults[owner] = { status: 'failed', requestedModel: route.model, error: String(error) };
            await persist();
            throw error;
          }
        }));
        const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw failures.find(result => result.reason instanceof GateError)?.reason ?? new Error(failures.map(result => String(result.reason)).join('; '));
        stage = 'integrate';
        assertContractHash(state.contractHash, state.plan, CONTRACT, state.templateHash!);
        if (await hashTree(input) !== cycle.inputHash || await hashTree(state.outputDir) !== cycle.inputHash) throw new GateError('集成输入已改变。');
        const staged = join(folder, `candidate-${randomUUID()}`);
        await copySource(input, staged);
        for (const owner of cycle.owners) {
          const route = owner === 'gemini' ? state.plan.routing!.ui : state.plan.routing!.logic;
          await applyPatch(await checkpointPatch(root, state, owner, route), staged);
        }
        const candidate = join(folder, 'candidate');
        // A crash before journaling may leave an unreferenced candidate; preserve it.
        if (await exists(candidate)) await rename(candidate, join(folder, `orphan-candidate-${randomUUID()}`));
        await rename(staged, candidate);
        cycle.integration = { sourceHash: await hashTree(candidate) };
        await persist();
        await publishCandidate(root, state);
        event(stage, `交付已集成，源码哈希 ${state.sourceHash!.slice(0, 12)}。`);
      }
      for (const owner of cycle.owners) state.workerResults[owner] = { ...state.workerResults[owner] as object, status: 'accepted' };
      addCompleted(state, 'ui', 'logic', 'integrate');
      await persist();
    }
    if (execution.phase !== 'check') throw new GateError('恢复阶段无效，请使用 resume 完整流程。');
    stage = 'check';
    if (await hashTree(state.outputDir) !== state.sourceHash) throw new GateError('验收前源码已改变。');
    event(stage, '执行安装、类型检查、构建、单元测试和浏览器测试。');
    await persist();
    const verification = await (deps.verifier ?? verifyProject)(state.outputDir);
    if (verification.sourceHash !== state.sourceHash || await hashTree(state.outputDir) !== state.sourceHash) throw new GateError('验收源码哈希不匹配。');
    state.checks = verification.checks;
    state.verificationPassed = verification.passed;
    state.review = null;
    addCompleted(state, 'check');
    execution.phase = 'review'; state.status = 'needs_review';
    event(stage, verification.passed ? '机器验收通过，等待独立审查。' : '机器验收未通过，进入问题定位。');
    await persist();
  } catch (error) {
    await writes;
    state.status = error instanceof GateError ? 'blocked' : 'failed';
    state.error = error instanceof Error ? error.message : String(error);
    event(stage, state.error);
    await saveRun(root, state);
  }
  return state;
}

export async function startRepair(root: string, id: string, decision: RepairDecision): Promise<RunState> {
  const state = await loadRun(root, id);
  const execution = state.execution;
  if (!execution || execution.cycle.round >= execution.maxRepairRounds || !state.sourceHash ||
      !['blocked', 'needs_review'].includes(state.status)) throw new Error('当前运行不能开始新的修复轮次。');
  if (decision.action !== 'repair' || !decision.reason?.trim() || !decision.tasks.length || decision.tasks.length > 2 ||
      new Set(decision.tasks.map(task => task.owner)).size !== decision.tasks.length || decision.tasks.some(task =>
        !['gemini', 'codex'].includes(task.owner) || !task.instructions?.trim() || task.instructions.length > 6000)) throw new Error('修复裁决格式无效。');
  assertContractHash(state.contractHash!, state.plan, CONTRACT, state.templateHash!);
  if (await hashTree(state.outputDir) !== state.sourceHash) throw new GateError('修复前源码已改变。');
  execution.history.push({ round: execution.cycle.round, sourceHash: state.sourceHash, checks: state.checks, review: state.review, decision });
  execution.cycle = { round: execution.cycle.round + 1, inputHash: state.sourceHash,
    owners: decision.tasks.map(task => task.owner), feedback: decision, checkpoints: {} };
  execution.phase = 'workers'; state.status = 'frozen'; state.error = null;
  delete state.pendingRepair;
  state.checks = []; state.verificationPassed = null; state.review = null;
  state.completed = state.completed.filter(stage => !['integrate', 'check', 'review', 'ready'].includes(stage));
  state.events.push({ time: new Date().toISOString(), stage: 'repair', message: `第 ${execution.cycle.round} 轮定向修复：${decision.reason}` });
  await saveRun(root, state);
  return state;
}
