# 真实生成的待办示例

源码位于 [examples/generated-todo](examples/generated-todo)。这是 0.2 的真实交付：Codex Astra 规划，agycli Gemini 3.8 Flash 生成界面，Codex Sol 实现状态与存储，agycli Opus 4.6 独立审查。该示例通过了 6 项单元测试、2 项浏览器测试，审查返回 0 项问题。

这次运行曾遇到 agycli 启动网络错误；resume 复用了 Codex 已完成的交付，仅重试 UI 模型，最后达到 ready。另一个专用验证副本注入类型错误，检验主模型裁决与副模型定向修复；详细证据见 VALIDATION.md。

在本包目录运行：

```powershell
cd examples/generated-todo
npm ci --ignore-scripts
npm run dev
```

打开 Vite 输出的本地地址，即可操作分类、待办、拖拽排序和本地保存。需要 Node.js 24+ 和 npm；也可通过 `node <npm-cli.js路径> ci --ignore-scripts` 安装依赖，再运行 `node node_modules/vite/bin/vite.js`。

测试命令：

```powershell
npm run typecheck
npm run build
npm run test:unit
npx playwright install chromium
npm run test:e2e
```

验收证据和适用范围见 [VALIDATION.md](VALIDATION.md)。
