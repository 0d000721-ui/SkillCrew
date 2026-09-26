import { cp, lstat, mkdir, rename, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashTree, saveRun, type RunState } from './run-store.js';
import { GateError, inspectPatch, type Patch } from './patch-gate.js';
import { CONTRACT } from './contract.js';
import type { Provider } from './adapters.js';
import type { Route } from './routing.js';
import { UNMANAGED_ROOT_NAMES } from './source-files.js';

export function cycleDirectory(root: string, state: RunState): string {
  const round = state.execution!.cycle.round;
  if (!Number.isInteger(round) || round < 0 || round > 2) throw new GateError('检查点轮次无效。');
  return join(root, 'runs', state.id, 'cycles', String(round));
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function copySource(from: string, to: string): Promise<void> {
  await hashTree(from); // Reject symlinks before following any source directories.
  await cp(from, to, { recursive: true, errorOnExist: true, force: false,
    filter: path => { const part = relative(from, path); return !part || part.includes(sep) || !UNMANAGED_ROOT_NAMES.has(part.toLowerCase()); } });
}
export const routeKey = (route: Route) => JSON.stringify([route.provider, route.model, route.effort ?? null, route.role]);
export function publicationDirectory(state: RunState): string {
  return join(dirname(state.outputDir), `.skillcrew-${state.id}-${state.execution!.cycle.round}`);
}

export async function assertNoUnmanagedFiles(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (UNMANAGED_ROOT_NAMES.has(entry.name.toLowerCase())) throw new GateError(`输出包含运行器不管理的文件或目录 ${entry.name}；已停止替换并保留原输出。`);
  }
}

export async function checkpointPatch(root: string, state: RunState, owner: Provider, route: Route): Promise<Patch> {
  const cycle = state.execution!.cycle;
  const saved = cycle.checkpoints[owner];
  if (!saved || !/^[a-f0-9-]{36}$/.test(saved.directoryName) || saved.inputHash !== cycle.inputHash ||
      saved.contractHash !== state.contractHash || saved.routeKey !== routeKey(route)) throw new GateError('检查点与输入、接口或模型不匹配。');
  const folder = cycleDirectory(root, state);
  const worker = join(folder, owner, saved.directoryName);
  if (await hashTree(worker) !== saved.treeHash) throw new GateError('worker 检查点内容已改变。');
  return inspectPatch(join(folder, 'input'), worker, [...CONTRACT.ownership[owner]]);
}

// The journal is persisted before either rename. A crash can leave old output, no output,
// or new output; recovery recognizes only those three hash-verified states.
export async function publishCandidate(root: string, state: RunState): Promise<void> {
  const execution = state.execution!;
  const cycle = execution.cycle;
  const journal = cycle.integration;
  if (!journal) throw new GateError('集成事务缺失。');
  const folder = cycleDirectory(root, state);
  // Publication and its rollback copy live beside output, so both renames stay
  // on the output filesystem even when the state directory is on another drive.
  const publication = publicationDirectory(state);
  const candidate = join(publication, 'candidate'), backup = join(publication, 'previous-output');
  const marker = join(publication, 'transaction.json');
  const identity = JSON.stringify({ id: state.id, round: cycle.round, sourceHash: journal.sourceHash, contractHash: state.contractHash });
  if (!await exists(publication)) {
    const staging = publication + '-' + randomUUID();
    await mkdir(staging);
    await writeFile(join(staging, 'transaction.json'), identity, { flag: 'wx' });
    await rename(staging, publication);
  }
  if (await readFile(marker, 'utf8') !== identity) throw new GateError('输出旁的集成事务目录不属于当前运行。');
  if (!await exists(candidate) && await exists(state.outputDir) && await hashTree(state.outputDir) === cycle.inputHash) {
    const original = join(folder, 'candidate');
    if (await hashTree(original) !== journal.sourceHash) throw new GateError('候选交付哈希不匹配。');
    const staged = join(publication, `copy-${randomUUID()}`);
    await copySource(original, staged);
    if (await hashTree(staged) !== journal.sourceHash) throw new GateError('跨目录暂存的候选交付哈希不匹配。');
    await rename(staged, candidate);
  }
  if (await exists(state.outputDir)) {
    const current = await hashTree(state.outputDir);
    if (current === journal.sourceHash) {
      state.sourceHash = current;
      execution.phase = 'check';
      await saveRun(root, state);
      return;
    }
    if (current !== cycle.inputHash) throw new GateError('输出项目已改变，不能覆盖用户改动。');
    await assertNoUnmanagedFiles(state.outputDir);
    if (await exists(backup)) throw new GateError('集成备份已存在，事务状态不一致。');
    if (await hashTree(candidate) !== journal.sourceHash) throw new GateError('候选交付哈希不匹配。');
    await rename(state.outputDir, backup);
  } else if (!await exists(backup) || await hashTree(backup) !== cycle.inputHash) {
    throw new GateError('输出缺失且无法验证集成备份。');
  }
  if (await hashTree(candidate) !== journal.sourceHash) throw new GateError('候选交付哈希不匹配。');
  await mkdir(join(state.outputDir, '..'), { recursive: true });
  await rename(candidate, state.outputDir);
  state.sourceHash = journal.sourceHash;
  execution.phase = 'check';
  await saveRun(root, state);
}
