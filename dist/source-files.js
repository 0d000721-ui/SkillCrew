// Only root-level tool artifacts are outside the source hash. Nested source files
// always participate, even when a directory happens to be named "dist".
export const UNMANAGED_ROOT_NAMES = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report']);
export function reservedWorkerPath(path) {
    return path.split('/').some(part => UNMANAGED_ROOT_NAMES.has(part.toLowerCase()) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part));
}
