import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashTree } from './run-store.js';
import { npmExecutable, runProcess } from './process.js';
export function verificationMode(value) {
    if (value === undefined || value === 'docker')
        return 'docker';
    if (value === 'local')
        return 'local';
    throw new Error('--verification 只支持 docker 或 local。');
}
export function localCheckEnvironment() {
    const allowed = new Set(['path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec', 'temp', 'tmp', 'home', 'userprofile', 'localappdata', 'appdata', 'playwright_browsers_path']);
    const env = { CI: '1' };
    for (const [key, value] of Object.entries(process.env))
        if (allowed.has(key.toLowerCase()))
            env[key] = value;
    return env;
}
async function localRun(directory, args, timeout) {
    const started = Date.now();
    const cli = args[0] === 'npm' ? npmExecutable() : { file: process.execPath, prefix: [] };
    const result = await runProcess({ file: cli.file, args: [...cli.prefix, ...args.slice(1)], cwd: directory,
        shell: false, stdin: null, env: localCheckEnvironment() }, timeout);
    return { code: result.code, output: result.output + '\n' + result.stderr, durationMs: Date.now() - started };
}
export function evaluateCheck(id, output, exitCode, requiredCount = 0) {
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    let count = 0;
    if (id === 'unit')
        count = Number(plain.match(/\bTests\s+(\d+)\s+passed\b/)?.[1] ?? 0);
    if (id === 'browser')
        count = Number(plain.match(/\b(\d+)\s+passed\s*\(/)?.[1] ?? 0);
    return { id, exitCode, count, requiredCount, passed: exitCode === 0 && count >= requiredCount, output: plain.slice(-16_000) };
}
function dockerRun(directory, image, args, network, timeoutMs) {
    return new Promise((resolve, reject) => {
        const name = `skillcrew-check-${randomUUID().slice(0, 12)}`;
        const started = Date.now();
        const command = ['run', '--rm', '--name', name, '--network', network, '--memory', '2g', '--pids-limit', '256',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', `${directory}:/app`, '-w', '/app', '-e', 'CI=1', image, ...args];
        const child = spawn('docker', command, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill('SIGKILL');
            const cleanup = spawn('docker', ['kill', name], { stdio: 'ignore', shell: false });
            cleanup.on('error', () => { });
            reject(new Error(`固定验收命令超过 ${timeoutMs / 1000} 秒。`));
        }, timeoutMs);
        const collect = (chunk) => { output = (output + chunk.toString('utf8')).slice(-100_000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', error => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? -1, output, durationMs: Date.now() - started });
        });
    });
}
export async function verifyProject(dir, mode = 'docker') {
    const sourceHash = await hashTree(dir);
    // Native realpath expands Windows 8.3 aliases; Vite's file watcher needs consistent paths.
    const scratch = await mkdtemp(join(realpathSync.native(tmpdir()), 'skillcrew-check-'));
    const project = join(scratch, 'app');
    const checks = [];
    try {
        await cp(dir, project, { recursive: true });
        const steps = [
            { id: 'install', image: 'node:24-bookworm', args: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], network: 'bridge', required: 0, timeout: 180_000 },
            { id: 'typecheck', image: 'mcr.microsoft.com/playwright:v1.55.1-noble', args: ['npm', 'run', 'typecheck'], network: 'none', required: 0, timeout: 90_000 },
            { id: 'build', image: 'mcr.microsoft.com/playwright:v1.55.1-noble', args: ['npm', 'run', 'build'], network: 'none', required: 0, timeout: 90_000 },
            { id: 'unit', image: 'mcr.microsoft.com/playwright:v1.55.1-noble', args: ['npm', 'run', 'test:unit'], network: 'none', required: 6, timeout: 90_000 },
            { id: 'browser', image: 'mcr.microsoft.com/playwright:v1.55.1-noble', args: ['npm', 'run', 'test:e2e'], network: 'none', required: 2, timeout: 150_000 },
        ];
        const localCommands = {
            install: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
            typecheck: ['node', './node_modules/typescript/bin/tsc', '--noEmit'],
            build: ['node', './node_modules/vite/bin/vite.js', 'build'],
            unit: ['node', './node_modules/vitest/vitest.mjs', 'run'],
            browser: ['node', './node_modules/@playwright/test/cli.js', 'test'],
        };
        for (const step of steps) {
            const args = mode === 'local' ? localCommands[step.id] : step.args;
            const execution = mode === 'local' ? await localRun(project, args, step.timeout) : await dockerRun(project, step.image, args, step.network, step.timeout);
            checks.push({ ...evaluateCheck(step.id, execution.output, execution.code, step.required), mode, command: args.join(' '), image: mode === 'docker' ? step.image : null, durationMs: execution.durationMs, sourceHash });
            if (checks.at(-1)?.passed !== true)
                break;
        }
        const unchanged = await hashTree(dir) === sourceHash;
        return { passed: unchanged && checks.length === steps.length && checks.every(check => check.passed === true), sourceHash, checks };
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
