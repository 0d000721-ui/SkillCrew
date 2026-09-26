export class AdapterError extends Error {
}
export function parseWorkerJsonl(provider, text, exitCode) {
    if (exitCode !== 0)
        throw new AdapterError(`${provider} 退出码 ${exitCode}，未交付有效结果。`);
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    let complete = false, model = null, summary = '';
    let usage = null, structuredOutput;
    for (const [index, line] of lines.entries()) {
        let event;
        try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('not object');
            event = parsed;
        }
        catch {
            throw new AdapterError(`${provider} 第 ${index + 1} 行不是有效 JSONL。`);
        }
        if (complete)
            throw new AdapterError(`${provider} 最终结果后仍有事件。`);
        if (provider === 'agy') {
            const type = event.event;
            if (!['init', 'step_update', 'result', 'error'].includes(type))
                throw new AdapterError(`agy 未知事件：${type}`);
            if (type === 'error')
                throw new AdapterError('agy 报告失败。');
            if (type === 'init' && typeof event.init?.model === 'string')
                model = event.init.model;
            if (type === 'result') {
                if (event.result?.status !== 'SUCCESS')
                    throw new AdapterError(`agy 最终结果失败：${event.result?.status ?? 'missing status'}`);
                if (event.result.denied_actions?.length)
                    throw new AdapterError('agy 权限检查拒绝了请求；本次调用未完成。');
                complete = true;
                structuredOutput = event.result.structured_output;
                summary = structuredOutput !== undefined ? JSON.stringify(structuredOutput) : String(event.result.response ?? '');
                usage = event.result.usage ?? null;
            }
        }
        else {
            const type = event.type;
            if (typeof type !== 'string' || (!['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(type) && !type.startsWith('item.')))
                throw new AdapterError(`Codex 未知事件：${type}`);
            if (type === 'error' || type === 'turn.failed')
                throw new AdapterError('Codex 报告失败。');
            if (type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string')
                summary = event.item.text;
            if (type === 'turn.completed') {
                complete = true;
                usage = event.usage ?? null;
            }
        }
    }
    if (!complete)
        throw new AdapterError(`${provider} 缺少最终结果事件。`);
    return { provider, complete, model, summary, structuredOutput, usage, eventCount: lines.length };
}
