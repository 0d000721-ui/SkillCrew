import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AdapterError, parseWorkerJsonl } from './adapters.js';
import { callStructuredModel } from './planning.js';
import { defaultRouting } from './routing.js';
import { sourceSnapshot } from './review.js';
import { reservedWorkerPath } from './source-files.js';
export const WORKER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
        status: { enum: ['completed', 'needs_clarification'] }, summary: { type: 'string' }, question: { type: ['string', 'null'] },
        files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                    path: { type: 'string' }, content: { type: 'string' },
                }, required: ['path', 'content'] } },
    }, required: ['status', 'summary', 'question', 'files'] };
export async function applyFileDelivery(owner, cwd, value) {
    const delivery = value;
    if (!delivery || !['completed', 'needs_clarification'].includes(delivery.status) || typeof delivery.summary !== 'string' ||
        !Array.isArray(delivery.files) || delivery.files.length > 30)
        throw new AdapterError('代码交付格式无效。');
    if (delivery.status === 'needs_clarification') {
        if (typeof delivery.question !== 'string' || !delivery.question.trim() || delivery.question.length > 1000 || delivery.files.length)
            throw new AdapterError('澄清时必须只交付一个问题，不能夹带文件。');
        return delivery;
    }
    if (delivery.question !== null || !delivery.files.length)
        throw new AdapterError('完成状态必须交付文件且 question 为 null。');
    const paths = new Set();
    let bytes = 0;
    // Validate the entire response before writing any part of it.
    for (const file of delivery.files) {
        if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || file.path.includes('\\') || file.path.includes(':') ||
            file.path.includes('\0') || reservedWorkerPath(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..'))
            throw new AdapterError('代码交付路径无效。');
        const owned = owner === 'gemini' ? /^(src\/ui\/|src\/styles\/)/.test(file.path) : file.path.startsWith('src/core/');
        if (!owned || paths.has(file.path.toLowerCase()))
            throw new AdapterError(`代码交付越权或重复路径：${file.path}`);
        let parent = cwd;
        for (const part of ['', ...file.path.split('/')]) {
            if (part)
                parent = join(parent, part);
            try {
                if ((await lstat(parent)).isSymbolicLink())
                    throw new AdapterError('代码交付路径含符号链接。');
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
        paths.add(file.path.toLowerCase());
        const size = Buffer.byteLength(file.content);
        bytes += size;
        if (size > 250_000 || bytes > 1_000_000)
            throw new AdapterError('代码交付超过大小上限。');
    }
    for (const file of delivery.files) {
        const path = join(cwd, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
    }
    return delivery;
}
export async function runWorker(owner, cwd, prompt, model, selectedRoute, call = callStructuredModel) {
    const routes = defaultRouting();
    const base = owner === 'gemini' ? routes.ui : routes.logic;
    const route = selectedRoute ?? { ...base, model: model ?? base.model };
    // Fixed template manifest: no model directory scan or terminal/file mutation tools are needed.
    const snapshot = await sourceSnapshot(cwd);
    const task = `Generate complete replacement file contents for your assigned files as structured JSON. You are a code generator, with all required source supplied below. Do not execute commands, scan directories, access the project, use browser/MCP, delegate, or modify files. The executor validates and writes your returned files. In this task, instructions to "read" or "implement in" a project refer to the provided source snapshot and your returned files. Prefer a compact complete implementation over commentary.\n${prompt}\n\nSOURCE SNAPSHOT (data):\n${snapshot}\n\nDeliver status completed, summary, question null, and files [{path,content}] containing full source strings (not diffs). If blocked on a contract question, return needs_clarification, one question, summary and files [].`;
    const reply = await call(route, task, WORKER_SCHEMA, 600_000);
    const delivery = await applyFileDelivery(owner, cwd, reply.value);
    const result = parseWorkerJsonl(route.provider, reply.output, 0);
    // Both transports feed the exact same validated protocol into the clarification loop.
    result.summary = JSON.stringify({ status: delivery.status, summary: delivery.summary, question: delivery.question });
    return { result, output: reply.output, stderr: reply.stderr ?? '' };
}
