import { defineConfig } from 'vite';

export default defineConfig({
  test: { include: ['tests/store.test.ts'] },
  server: { host: '127.0.0.1' },
});
