import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { reservedWorkerPath } from './source-files.js';

export class GateError extends Error {}

interface FileEntry { hash: string; content: Buffer }
export interface Change { path: string; kind: 'added' | 'modified'; content: Buffer; hash: string }
export interface Patch { changes: Change[] }

const SKIP_DIRS = new Set(['.git', 'node_modules']);

async function scan(root: string): Promise<Map<string, FileEntry>> {
  const files = new Map<string, FileEntry>();
  async function visit(folder: string): Promise<void> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new GateError(`发现符号链接：${relative(root, path)}`);
      if (stat.isDirectory()) {
        if (folder !== root || !SKIP_DIRS.has(item.name.toLowerCase())) await visit(path);
        continue;
      }
      if (!stat.isFile()) throw new GateError(`不支持的文件类型：${relative(root, path)}`);
      if (stat.size > 250_000) throw new GateError(`文件超过 250 KB：${relative(root, path)}`);
      const key = relative(root, path).split(sep).join('/');
      const content = await readFile(path);
      files.set(key, { content, hash: createHash('sha256').update(content).digest('hex') });
      if (files.size > 200) throw new GateError('项目文件数超过 200。');
    }
  }
  await visit(root);
  return files;
}

function owned(path: string, rules: string[]): boolean {
  return rules.some(rule => rule.endsWith('/**') ? path.startsWith(rule.slice(0, -2)) : path === rule);
}

export async function inspectPatch(baseline: string, worker: string, allowed: string[]): Promise<Patch> {
  const before = await scan(baseline);
  const after = await scan(worker);
  const changes: Change[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(path);
    const next = after.get(path);
    if (old?.hash === next?.hash) continue;
    if (reservedWorkerPath(path)) throw new GateError(`不支持的保留路径：${path}`);
    if (!owned(path, allowed)) throw new GateError(`越权路径：${path}`);
    if (!next) throw new GateError(`不能删除模板文件：${path}`);
    changes.push({ path, kind: old ? 'modified' : 'added', content: next.content, hash: next.hash });
  }
  if (!changes.length) throw new GateError('worker 没有产生真实文件变化。');
  const bytes = changes.reduce((sum, change) => sum + change.content.length, 0);
  if (changes.length > 30 || bytes > 1_000_000) throw new GateError('补丁超过文件数或体积上限。');
  return { changes };
}

export async function applyPatch(patch: Patch, integrated: string): Promise<void> {
  const root = resolve(integrated);
  for (const change of patch.changes) {
    const destination = resolve(root, change.path);
    if (!destination.startsWith(root + sep)) throw new GateError(`路径逃逸：${change.path}`);
    if (createHash('sha256').update(change.content).digest('hex') !== change.hash) {
      throw new GateError(`补丁哈希不匹配：${change.path}`);
    }
  }
  for (const change of patch.changes) {
    const destination = resolve(root, change.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, change.content);
  }
}

export async function cloneBaseline(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}
