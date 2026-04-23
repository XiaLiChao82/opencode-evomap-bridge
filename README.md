# opencode-evomap-bridge

`opencode-evomap-bridge` 是一个 **OpenCode 插件**。它通过稳定的 `tool.execute.before` / `tool.execute.after` hooks 观察工具执行行为，提取轻量级的 EvoMap 风格信号，并把这些信号转成后续调用可消费的最小 advisory。

它的目标不是替代 agent，也不是自动改代码，而是：

- 识别重复失败模式
- 识别可复用的成功模式
- 识别过慢的工具调用
- 在后续工具调用中追加短小、有限、可衰减的执行建议

---

## 特性

- 基于 **稳定 hooks**：`tool.execute.before` / `tool.execute.after`
- 异步采样工具执行信号，不阻塞主工具链路
- 生成有限 observation 类型：
  - `repeat_failure`
  - `repeat_success`
  - `slow_execution`
- 使用 **session / project** 两级状态
- repo 级仅保留 candidate，不自动写仓库文件
- 带 fail-open、防回流、冷却时间、使用次数上限等保护机制

---

## 当前行为模型

当前版本采用一个保守的闭环：

1. `tool.execute.after` 捕获工具结果
2. 将结果采样为 `RawToolSignal`
3. 异步写入本地状态，并生成 `Observation`
4. 将 observation 转成 `ExecutionAdvisory`
5. 在下一次相关工具调用时，由 `tool.execute.before` 选择 advisory
6. 在后续 `tool.execute.after` 中把 advisory 追加到工具输出末尾

这意味着它当前更像一个 **post-tool guidance bridge**，而不是 system prompt 注入器。

---

## 项目结构

```text
.opencode/plugin/evomap.ts   # 插件入口
src/                         # 核心实现
tests/                       # 最小测试
BLUEPRINT.md                 # 实施蓝图
```

核心模块：

- `src/config.ts`：默认配置
- `src/types.ts`：核心类型
- `src/evolver.ts`：observation 生成逻辑
- `src/advisory.ts`：advisory 选择与渲染
- `src/state.ts`：session/project 状态
- `src/queue.ts`：异步信号队列

---

## 安装

### 方式 1：作为本地插件使用

在你的 OpenCode 项目配置中引用本地插件路径：

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-evomap-bridge/.opencode/plugin/evomap.ts"
  ]
}
```

适合本地开发和调试。

---

### 方式 2：作为 npm 包使用

发布后可直接在 OpenCode 配置里声明：

```json
{
  "plugin": ["opencode-evomap-bridge"]
}
```

> 前提是该包已发布到 npm，且运行环境能解析到它。

---

## opencode 配置示例

### 最小示例

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-evomap-bridge"]
}
```

### 本地开发示例

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///Users/you/dev/opencode-evomap-bridge/.opencode/plugin/evomap.ts"
  ]
}
```

### 与其他插件并用

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-evomap-bridge",
    "@nick-vi/opencode-type-inject"
  ]
}
```

---

## 使用说明

你不需要显式调用这个插件提供的工具。它当前是一个 **被动观察 + 被动增强** 的插件：

- 当 OpenCode 执行工具时，它记录行为
- 当它识别到重复失败、重复成功或慢调用时，会在后续相关调用中追加短 advisory

### 典型场景

#### 1. 重复失败

如果某个 `bash` 调用以相同模式连续失败多次，插件会产生类似建议：

```text
Repeated bash failures detected. Avoid retrying the same failing pattern without narrowing the scope or checking diagnostics first.
```

#### 2. 成功模式复用

如果某种较窄范围的调用最近重复成功，插件会建议优先复用这个模式，而不是再次扩大范围。

#### 3. 过慢调用

如果某个工具调用明显过慢，插件会建议缩小 glob、offset、limit 或命令范围。

---

## 本地状态

插件会把状态写到用户目录下，而不是写进当前仓库：

```text
~/.opencode/evomap-bridge/<project-hash>/
```

其中通常包括：

- `project-state.json`
- `sessions/<session-id>.json`

这样可以避免污染目标项目仓库。

---

## 开发

```bash
bun install
bun run typecheck
bun run test
```

---

## 测试

当前带了最小测试覆盖：

- `tests/evolver.test.ts`
- `tests/state.test.ts`

覆盖点包括：

- repeat failure 识别
- slow execution 识别
- advisory 渲染
- project 级提升

---

## 限制

当前版本是 MVP，有明确边界：

- 仅使用稳定 hooks，不依赖 `experimental.*`
- 不做 system prompt transform
- 不做 session compaction 注入
- 不做 repo 级自动规则落盘
- 不接外部 mailbox / worker / Hub
- 当前 advisory 是追加到工具输出，而不是前置改写模型推理链

---

## 后续可扩展方向

- 引入更细粒度 observation 类型
- 引入更强的 advisory 选择策略
- 接入 `experimental.session.compacting`
- 接入 `experimental.chat.system.transform`
- 增加人工审核的 repo-candidate 提升流程

---

## 设计文档

详细实施蓝图见：

- `BLUEPRINT.md`
