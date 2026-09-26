import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export interface Executable { file: string; prefix: string[] }

// Never execute .cmd/.ps1 shims through a shell with model-controlled arguments.
export function executable(name: 'agy' | 'codex'): Executable {
  const override = process.env[`SKILLCREW_${name.toUpperCase()}_BIN`];
  if (override) {
    if (process.platform === 'win32' && !override.toLowerCase().endsWith('.exe')) throw new Error(`${name} Windows 路径必须指向原生 .exe。`);
    return { file: override, prefix: [] };
  }
  if (process.platform !== 'win32') return { file: name, prefix: [] };
  const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of path.split(delimiter)) {
    const file = join(directory.replace(/^"|"$/g, ''), `${name}.exe`);
    if (existsSync(file)) return { file, prefix: [] };
  }
  const bundled = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), '.sandbox-bin', 'codex.exe');
  if (name === 'codex' && existsSync(bundled)) return { file: bundled, prefix: ['--no-daemon'] };
  return { file: `${name}.exe`, prefix: [] };
}

export function npmExecutable(): Executable {
  const override = process.env.SKILLCREW_NPM_CLI;
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const script = override ?? (existsSync(bundled) ? bundled : null);
  if (script) return { file: process.execPath, prefix: [script] };
  if (process.platform === 'win32') throw new Error('找不到 npm-cli.js；请安装包含 npm 的 Node.js，或设置 SKILLCREW_NPM_CLI。');
  return { file: 'npm', prefix: [] };
}

export function providerEnvironment(provider: 'agy' | 'codex'): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.GEMINI_API_KEY;
  if (provider !== 'codex') { delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; }
  return env;
}

export interface ProcessCommand { file: string; args: string[]; cwd: string; stdin: string | null; env: NodeJS.ProcessEnv; shell: false }

export class ProcessError extends Error {
  constructor(message: string, public output = '', public stderr = '') { super(message); }
}

export async function runProcess(command: ProcessCommand, timeoutMs: number, limit = 2_000_000): Promise<{ output: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', failure: Error | null = null, finished = false;
    const stop = (reason: string) => {
      if (finished || failure) return;
      failure = new Error(reason);
      if (child.pid && process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop(`调用超过 ${timeoutMs / 1000} 秒上限。`), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (!failure) output += chunk; if (output.length > limit) stop('调用输出超过大小上限。'); });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error.message); });
    child.on('error', error => { finished = true; clearTimeout(timer); reject(new Error(`无法启动 ${command.file}：${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (failure) reject(new ProcessError(failure.message, output, stderr)); else resolve({ output, stderr, code: code ?? -1 });
    });
    child.stdin.end(command.stdin ?? undefined);
  });
}
