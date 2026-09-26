import { join } from 'node:path';
import { assertContractHash } from './protocol.js';
import { hashTree } from './run-store.js';
import { CONTRACT } from './contract.js';
import { GateError } from './patch-gate.js';
export async function assertFrozenIntegrity(root, state) {
    if (!state.contractHash || !state.templateHash)
        throw new GateError('缺少冻结接口哈希。');
    if (state.request !== state.plan.request)
        throw new GateError('运行需求与冻结计划不一致。');
    try {
        assertContractHash(state.contractHash, state.plan, CONTRACT, state.templateHash);
        if (await hashTree(join(root, 'runs', state.id, 'baseline')) !== state.templateHash)
            throw new Error('冻结模板哈希不匹配。');
    }
    catch (error) {
        throw new GateError(error.message);
    }
}
