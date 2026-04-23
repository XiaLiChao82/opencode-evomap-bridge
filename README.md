# opencode-evomap-bridge

OpenCode 插件：从工具执行行为中提取轻量级 EvoMap 风格信号，并在后续工具调用中应用最小建议。

## 当前范围

- 使用稳定 hooks：`tool.execute.before` / `tool.execute.after`
- 异步采样工具执行信号
- 生成有限类型 observation：
  - `repeat_failure`
  - `repeat_success`
  - `slow_execution`
- 将 observation 转换为 advisory，并在后续调用中消费
- 使用 session/project 两级状态
- repo 级仅保留候选，不自动写入仓库

## 安装

```json
{
  "plugin": ["opencode-evomap-bridge"]
}
```

## 开发

```bash
bun install
bun run typecheck
bun run test
```

## 入口

- 插件入口：`.opencode/plugin/evomap.ts`
- 核心实现：`src/`
- 设计蓝图：`BLUEPRINT.md`
