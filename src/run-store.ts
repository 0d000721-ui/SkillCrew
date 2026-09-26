import { withFileLease } from './lease.js';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONTRACT } from './contract.js';
import { freezePlan, parseRequest, type CollaborationRecord, type Plan } from './protocol.js';
import { defaultRouting, type LeadMode, type RouteOverrides, type RoutingPolicy } from './routing.js';
import type { ExecutionState, RepairDecision } from './execution-types.js';
import { loadSkills, type SkillSnapshot } from './skills.js';
import { UNMANAGED_ROOT_NAMES } from './source-files.js';
import { currentLocale } from './i18n.js';

export interface PlanProposal {
  summary: string;
  acceptanceMapping: Record<string, string>;
}

export type RunStatus = 'planned' | 'frozen' | 'running' | 'needs_review' | 'ready' | 'blocked' | 'failed' | 'interrupted';

export interface RunEvent { time: string; stage: string; message: string }
export interface DialogueEntry {
  time: string;
  provider: 'gemini' | 'codex';
  question: string;
  answer: string;
  contractHash: string;
  requestedModel: string;
  observedModel: string | null;
}
export interface RunState {
  schemaVersion: 1;
  id: string;
  request: string;
  plan: Plan;
  outputDir: string;
  status: RunStatus;
  contractHash: string | null;
  templateHash: string | null;
  completed: string[];
  events: RunEvent[];
  dialogue: DialogueEntry[];
  workerResults: Record<string, unknown>;
  checks: Record<string, unknown>[];
  verificationPassed: boolean | null;
  review: Record<string, unknown> | null;
  sourceHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  execution?: ExecutionState;
  workflow?: { maxRepairRounds: number; verification: 'docker' | 'local' };
  pendingRepair?: RepairDecision;
  freezePreparation?: { templateHash: string; contractHash: string };
}

const now = () => new Date().toISOString();
const stateFile = (root: string, id: string) => join(root, 'runs', id, 'state.json');

export async function withRunLock<T>(root: string, id: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的运行 ID。');
  const folder = join(root, 'runs', id);
  await mkdir(folder, { recursive: true });
  return withFileLease(join(folder, 'operation.lock'), operation);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function hashTree(root: string): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('源码根目录不能是符号链接。');
  const digest = createHash('sha256');
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === root && UNMANAGED_ROOT_NAMES.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`模板含符号链接：${relative(root, path)}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        digest.update(relative(root, path).split(sep).join('/'));
        digest.update('\0');
        digest.update(await readFile(path));
        digest.update('\0');
      } else throw new Error(`不支持的模板文件类型：${relative(root, path)}`);
    }
  }
  await visit(root);
  return digest.digest('hex');
}

export async function saveRun(root: string, state: RunState): Promise<void> {
  state.updatedAt = now();
  const file = stateFile(root, state.id);
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, file);
  await writeFile(join(root, 'runs', state.id, 'events.jsonl'), state.events.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

export async function loadRun(root: string, id: string): Promise<RunState> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的运行 ID。');
  const state = JSON.parse(await readFile(stateFile(root, id), 'utf8')) as RunState;
  if (state.schemaVersion !== 1 || state.id !== id) throw new Error('运行状态版本或 ID 不匹配。');
  return state;
}

export async function createRun(root: string, request: string, outputDir: string, mode: LeadMode = 'single', overrides: RouteOverrides = {}, configuration: { routing?: RoutingPolicy; skills?: SkillSnapshot[] } = {}): Promise<RunState> {
  const plan = parseRequest(request);
  plan.responseLanguage = currentLocale().language;
  plan.routing = configuration.routing ?? defaultRouting(mode, overrides);
  plan.skills = configuration.skills ?? await loadSkills();
  const output = resolve(outputDir);
  const stateRoot = resolve(root);
  if (await exists(output)) throw new Error(`输出目录已经存在：${output}`);
  if (output === stateRoot || output.startsWith(stateRoot + sep) || stateRoot.startsWith(output + sep)) throw new Error('输出目录与运行状态目录不能互相包含。');
  const id = randomUUID();
  const state: RunState = {
    schemaVersion: 1, id, request: plan.request, plan, outputDir: output,
    status: 'planned', contractHash: null, templateHash: null,
    completed: [], events: [{ time: now(), stage: 'plan', message: '需求已限定为 react-todo；等待模型规划和验收映射。' }],
    dialogue: [], workerResults: {}, checks: [], verificationPassed: null, review: null, sourceHash: null, error: null,
    createdAt: now(), updatedAt: now(),
  };
  await saveRun(root, state);
  await writeFile(join(root, 'runs', id, 'request.json'), JSON.stringify({ request: state.request }, null, 2));
  return state;
}

export async function setRunPlan(root: string, id: string, proposal: PlanProposal, planner?: Plan['planner'], collaboration?: CollaborationRecord): Promise<RunState> {
  const state = await loadRun(root, id);
  if (state.status !== 'planned') throw new Error('只有计划阶段可以提交计划。');
  if (typeof proposal?.summary !== 'string' || !proposal.summary.trim() || proposal.summary.length > 1000 ||
      !proposal.acceptanceMapping || typeof proposal.acceptanceMapping !== 'object' || Array.isArray(proposal.acceptanceMapping) ||
      state.plan.acceptanceIds.some(acceptanceId => {
        const detail = proposal.acceptanceMapping[acceptanceId];
        return typeof detail !== 'string' || !detail.trim() || detail.length > 500;
      })) throw new Error('计划缺少完整的验收映射或摘要。');
  state.plan.summary = proposal.summary.trim();
  const mapping = proposal.acceptanceMapping;
  state.plan.acceptanceMapping = Object.fromEntries(state.plan.acceptanceIds.map(acceptanceId => [acceptanceId, mapping[acceptanceId]!.trim()]));
  if (collaboration) {
    const noteIds = new Set(collaboration.notes.map(note => note.id));
    const decided = new Set(collaboration.decisions.map(decision => decision.noteId));
    if (noteIds.size !== collaboration.notes.length || decided.size !== collaboration.decisions.length ||
        collaboration.notes.some(note => !note.id || !note.text?.trim() || !['gemini', 'codex'].includes(note.provider) ||
          !['question', 'risk', 'suggestion'].includes(note.kind) ||
          (note.acceptanceId !== null && !state.plan.acceptanceIds.includes(note.acceptanceId))) ||
        collaboration.decisions.some(decision => !noteIds.has(decision.noteId) || !['adopt', 'decline'].includes(decision.disposition) || !decision.reason?.trim()) ||
        collaboration.notes.some(note => !decided.has(note.id))) throw new Error('主模型尚未逐条回应副模型建议。');
    state.plan.collaboration = collaboration;
  }
  if (planner) state.plan.planner = planner;
  if (!state.completed.includes('plan')) state.completed.push('plan');
  state.events.push({ time: now(), stage: 'plan', message: `规划已写入，覆盖 ${state.plan.acceptanceIds.length} 条验收。` });
  await saveRun(root, state);
  await writeFile(join(root, 'runs', id, 'plan.json'), JSON.stringify(state.plan, null, 2));
  return state;
}

export async function freezeRun(root: string, id: string, template: string): Promise<RunState> {
  const state = await loadRun(root, id);
  if (state.status !== 'planned') throw new Error('只有计划阶段可以冻结接口。');
  if (!state.completed.includes('plan')) throw new Error('缺少模型计划，不能冻结接口。');
  const templateHash = await hashTree(template);
  const contractHash = freezePlan(state.plan, CONTRACT, templateHash);
  const baseline = join(root, 'runs', id, 'baseline');
  if (!state.freezePreparation) {
    if (await exists(state.outputDir)) throw new Error(`输出目录已经存在：${state.outputDir}`);
    state.freezePreparation = { templateHash, contractHash };
    await saveRun(root, state);
  }
  if (state.freezePreparation.templateHash !== templateHash || state.freezePreparation.contractHash !== contractHash) throw new Error('冻结准备哈希不匹配。');
  for (const target of [baseline, state.outputDir]) {
    if (await exists(target)) {
      if (await hashTree(target) !== templateHash) throw new Error('已存在的冻结快照或输出被修改，不能覆盖。');
    } else {
      const staged = join(dirname(target), `.skillcrew-freeze-${id}-${randomUUID()}`);
      await cp(template, staged, { recursive: true, force: false, errorOnExist: true });
      if (await hashTree(staged) !== templateHash) throw new Error('冻结过程中模板发生改变。');
      await rename(staged, target);
    }
  }
  state.templateHash = templateHash;
  state.contractHash = contractHash;
  state.status = 'frozen';
  state.completed = [...new Set([...state.completed, 'freeze'])];
  state.events.push({ time: now(), stage: 'freeze', message: `接口与模板已冻结：${contractHash.slice(0, 12)}` });
  await saveRun(root, state);
  await writeFile(join(root, 'runs', id, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, runId: id, templateVersion: CONTRACT.templateVersion,
    templateHash, contractHash, routing: state.plan.routing, outputDir: state.outputDir,
  }, null, 2));
  return state;
}
