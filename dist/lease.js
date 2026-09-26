import { randomUUID } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
// Hard-link a fully written record to publish an exclusive lock without an empty
// file window. Recovery uses the same protocol recursively, so a recovery owner
// that crashes can also be reclaimed. Unverifiable/remote/live records fail closed.
export async function withFileLease(path, operation) {
    const token = randomUUID();
    const record = join(dirname(path), `.lock-record-${token}`);
    const own = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token };
    await writeFile(record, JSON.stringify(own), { flag: 'wx' });
    const read = async (target) => {
        try {
            return JSON.parse(await readFile(target, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw new Error(`无法核验锁记录，请保留并检查：${target}`);
        }
    };
    const requireDead = (value, target) => {
        if (value.host === hostname() && Number.isInteger(value.pid) && value.pid > 0) {
            try {
                process.kill(value.pid, 0);
            }
            catch (error) {
                if (error.code === 'ESRCH')
                    return;
            }
        }
        throw new Error(`此运行已有操作或不可核验的锁；请检查 ${target} 对应的进程。`);
    };
    const acquire = async (target, depth = 0) => {
        if (depth > 8)
            throw new Error(`锁恢复嵌套超过上限，请检查 ${target}。`);
        try {
            await link(record, target);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const observed = await read(target);
            if (observed)
                requireDead(observed, target);
            const recovery = depth === 0 ? join(dirname(path), 'recovery.lock') : target + '.recovery';
            const releaseRecovery = await acquire(recovery, depth + 1);
            try {
                const current = await read(target);
                if (current) {
                    requireDead(current, target);
                    await unlink(target);
                }
                // A new caller may win this exact gap. EEXIST must never delete its lock.
                try {
                    await link(record, target);
                }
                catch (error) {
                    if (error.code === 'EEXIST')
                        throw new Error(`此运行已有操作在进行：${target}`);
                    throw error;
                }
            }
            finally {
                await releaseRecovery();
            }
        }
        return async () => { if ((await read(target))?.token === token)
            await unlink(target); };
    };
    try {
        const release = await acquire(path);
        try {
            return await operation();
        }
        finally {
            await release();
        }
    }
    finally {
        await unlink(record);
    }
}
