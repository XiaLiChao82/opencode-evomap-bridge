# EvoMap Bridge — Blueprint

> **版本**: v0.1.0  
> **日期**: 2026-04-23  
> **定位**: 实施蓝图，反映实际代码结构。  

---

## A) 插件包目录树

```
opencode-evomap-bridge/
├── package.json                        # main → .opencode/plugin/evomap.ts
├── tsconfig.json                       # strict, ESM, target ES2022
│
├── .opencode/
│   └── plugin/
│       └── evomap.ts                   # 插件入口：注册所有 hooks + event handlers
│
├── src/
│   ├── spawn.ts                        # evolver CLI 检测、spawn、超时、路径解析
│   ├── bridge.ts                       # OpenCode signal ↔ evolver 格式转换、memory_graph 读写
│   ├── evolver.ts                      # deriveObservationsWithEvolver + 本地 fallback
│   ├── doctor.ts                       # 诊断工具（5 项检查 + 格式化输出）
│   ├── advisory.ts                     # advisory 选择、标记、渲染
│   ├── state.ts                        # session / project 两级状态管理
│   ├── queue.ts                        # 异步信号队列（microtask-based）
│   ├── config.ts                       # 默认配置 + resolveConfig
│   ├── types.ts                        # 所有核心类型定义
│   └── util.ts                         # 工具函数（hash、路径、时间、JSON 读写）
│
├── tests/
│   ├── evolver.test.ts                 # 本地 observation 规则 + advisory 渲染
│   ├── state.test.ts                   # session/project 状态管理
│   ├── bridge.test.ts                  # 格式转换、memory_graph 读写、spawn 路径
│   └── doctor.test.ts                  # 5 项诊断检查 + 格式化输出
│
├── README.md                           # 中文文档
├── README_EN.md                        # 英文文档
└── BLUEPRINT.md                        # 本文件
```

---

## B) 模块职责

| 文件 | 职责 | 输入 | 输出 | 副作用 |
|---|---|---|---|---|
| **evomap.ts** | 插件入口。注册全部 7 个 hook handlers，协调各模块。 | OpenCode hook API | hook handlers | 无 |
| **spawn.ts** | 检测 evolver CLI 可用性、spawn 子进程、管理超时、解析路径。 | 命令名 + cwd | `EvolverDetection` / `EvolverSpawnResult` | 子进程 |
| **bridge.ts** | OpenCode signal ↔ evolver `EvolverMemoryEntry` 格式互转；memory_graph.jsonl 读写。 | `RawToolSignal` / JSONL | `EvolverMemoryEntry[]` | 文件读写 |
| **evolver.ts** | 核心决策：evolver 可用时走 CLI 链路，不可用时 fallback 到本地规则。 | signal + history + config | `Observation[]` | 可能 spawn evolver |
| **doctor.ts** | 5 项诊断检查（CLI、root dir、memory_graph、plugin、config）+ 格式化输出。 | directory path | `DoctorResult` | 读文件系统 |
| **advisory.ts** | 从 observations 中选择 advisory、标记已使用、渲染为 LLM 可读文本。 | observations + config | `ExecutionAdvisory[]` + rendered text | 无 |
| **state.ts** | SessionState + ProjectState 两级状态管理。内存持有 + JSON 持久化。 | CRUD ops | `SessionState` / `ProjectState` | 文件读写 |
| **queue.ts** | 内存异步队列。push → 内部 microtask 消费 → callback 处理。 | `RawToolSignal` | callback invocation | 异步 |
| **config.ts** | 默认配置值 + `resolveConfig()` 合并用户覆盖。 | partial override | `EvoMapConfig` | 无 |
| **types.ts** | 全部核心类型：Signal、Observation、Advisory、State、Config、Evolver。 | — | — | 无 |
| **util.ts** | 工具函数：`stableHash`、`getDataDir`、`nowIso`、`readJsonFile`/`writeJsonFile`。 | — | — | 文件读写 |

---

## C) Hook 注册与数据流

插件注册 7 个 hook handlers：

```
┌──────────────────────────────────────────────────────────────────────┐
│  event(session.created)                                              │
│  读 evolver memory_graph → 注入进化记忆到 session 启动日志           │
├──────────────────────────────────────────────────────────────────────┤
│  experimental.chat.system.transform                                  │
│  将 evolver memory 或本地 observations 注入系统提示                   │
├──────────────────────────────────────────────────────────────────────┤
│  tool.execute.after                                                  │
│  1. 从 hook context 构造 RawToolSignal                               │
│  2. 检测 synthetic sentinel → 跳过 advisory 输出（防自激）           │
│  3. queue.push(signal)                                               │
│  4. 异步 callback: state.appendSignal → deriveObservations           │
├──────────────────────────────────────────────────────────────────────┤
│  tool.execute.before                                                 │
│  1. 读 session + project observations                                │
│  2. pickAdvisories（cooldown + budget）                              │
│  3. 记录 pendingAdvisories                                           │
│  4. 在 after 中追加到工具输出末尾                                     │
├──────────────────────────────────────────────────────────────────────┤
│  experimental.session.compacting                                     │
│  保留 session observations + project observations + evolver memory   │
│  到压缩上下文，确保 compaction 不丢失关键信息                        │
├──────────────────────────────────────────────────────────────────────┤
│  event(session.idle)                                                 │
│  构造 session-end 条目 → appendMemoryGraph → spawn evolver run       │
└──────────────────────────────────────────────────────────────────────┘
```

**信号处理详细流程**：

```
tool.execute.after
      │
      ▼
buildSignal(context) → RawToolSignal
      │
      ▼
queue.push(signal)
      │
      ▼ (异步 microtask)
onSignal(signal, directory):
  ├─ state.appendSignal(signal)
  └─ deriveObservationsWithEvolver(signal, history, config, directory):
      ├─ evolver 可用?
      │   ├─ signalToEvolverEntry(signal) → 写入 memory_graph.jsonl
      │   ├─ spawnEvolver({ command: "run", cwd }) → 触发 GEP 进化
      │   └─ readMemoryGraph → evolverGEPObservations → 返回 observations
      └─ fallback: deriveObservations(signal, history, config)
          ├─ repeat_failure: 同一工具连续失败 N 次
          ├─ repeat_success: 同一模式连续成功
          └─ slow_execution: 执行时长超过阈值
      │
      ▼
state.appendObservations(sessionId, observations)
→ 生成 ExecutionAdvisory
→ 下次 tool.execute.before 时 pickAdvisories 注入
```

---

## D) 核心类型

```typescript
// ─── types.ts ───

type ToolName = "bash" | "read" | "write" | "edit" | "glob" | "grep" | "unknown";
type ObservationType = "repeat_failure" | "repeat_success" | "slow_execution";

interface RawToolSignal {
  id: string;
  sessionId: string;
  tool: ToolName;
  args: Record<string, unknown>;
  result: {
    exitCode: number | null;
    success: boolean;
    durationMs: number;
    outputDigest: string;
    errorSnippet: string | null;
  };
  timestamp: string;
  projectId: string;
}

interface Observation {
  id: string;
  type: ObservationType;
  tool: ToolName;
  sessionId: string;
  projectId: string;
  fingerprint: string;
  message: string;
  confidence: number;
  occurrenceCount: number;
  evidenceSignalIds: string[];
  pathHints: string[];
  createdAt: string;
  lastSeenAt: string;
  projectEligible: boolean;
}

interface ExecutionAdvisory {
  id: string;
  tool: ToolName;
  observationId: string;
  type: ObservationType;
  body: string;
  fingerprint: string;
  targetTools: ToolName[];
  injectedCount: number;
  maxUses: number;
  lastInjectedAt: string;
  sourceLevel: "session" | "project";
}

interface SessionState {
  sessionId: string;
  recentSignals: RawToolSignal[];
  observations: Observation[];
  advisories: ExecutionAdvisory[];
  updatedAt: string;
}

interface ProjectState {
  projectId: string;
  observations: Observation[];
  advisories: ExecutionAdvisory[];
  repoCandidates: Observation[];
  updatedAt: string;
}

// ─── evolver 相关类型 ───

interface EvolverMemoryEntry {
  timestamp: string;
  gene_id: string;
  signals: string[];
  outcome: { status: string; score: number; note: string };
  source: string;
}

interface EvolverDetection {
  available: boolean;
  path: string;
  version: string;
}

interface EvolverSpawnOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  input?: string;
}

interface EvolverSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ─── 配置 ───

interface EvoMapConfig {
  enabled: boolean;
  debug: boolean;
  maxRecentSignals: number;
  maxAdvisoriesPerCall: number;
  maxAdvisoryUses: number;
  advisoryCooldownMs: number;
  repeatFailureThreshold: number;
  repeatSuccessThreshold: number;
  slowExecutionMs: number;
  internalErrorThreshold: number;
  evolverBinary: string;
  evolverSpawnTimeoutMs: number;
  evolverFallbackToLocal: boolean;
}
```

---

## E) 数据目录布局

```
# 插件状态（OpenCode 侧）
~/.opencode/evomap-bridge/<project-hash>/
├── project-state.json
└── sessions/<session-id>.json

# evolver 数据（EvoMap 侧）
<project>/.evomap/
└── memory/evolution/
    └── memory_graph.jsonl
```

**关键规则**：
1. 插件状态写在用户目录，不污染项目仓库。
2. `memory_graph.jsonl` 由 evolver 管理，插件只追加（signal）和读取（observations）。
3. 所有 hook handlers 包裹在 `failOpen()` 中，任何内部错误不影响宿主。

---

## F) 实施记录

### Phase 1: CLI Spawn 层 ✅
- `src/spawn.ts` — evolver 检测、spawn、超时、路径
- `src/bridge.ts` — 格式转换、memory_graph 读写
- `src/types.ts` — 扩展 evolver 相关类型
- `src/config.ts` — 扩展 evolver 配置
- `package.json` — 添加 `@evomap/evolver` peerDependency

### Phase 2: 信号链路改造 ✅
- `src/evolver.ts` — `deriveObservationsWithEvolver()` + fallback
- `src/queue.ts` — 构造函数新增 `directory` 参数
- `.opencode/plugin/evomap.ts` — 接入 evolver 集成
- `tests/bridge.test.ts` — 15 个测试
- `tsconfig.json` — 修复类型检查

### Phase 3: Session 生命周期 + Doctor + README ✅
- `.opencode/plugin/evomap.ts` — `event` hook（session.created / session.idle）
- `src/bridge.ts` — `formatMemorySummary()`
- `src/doctor.ts` — 5 项诊断检查
- `tests/doctor.test.ts` — 12 个测试
- `README.md` — 重写

### Phase 4: Experimental Hooks ✅
- `experimental.chat.system.transform` — 注入 evolver memory / 本地 observations 到系统提示
- `experimental.session.compacting` — 在压缩时保留 observations 和记忆
- `README.md` + `README_EN.md` — 去掉已实现限制和扩展项

### Phase 5: 发布准备 ✅
- `package.json` — exports map、keywords、license
- `README_EN.md` — 英文版文档
- `BLUEPRINT.md` — 更新为实际实现

---

## G) 端到端场景

### 场景 1: Evolver 可用 — 完整链路

```
1. session.created
   → 读 memory_graph.jsonl 最近 10 条
   → formatMemorySummary → console.warn 注入日志

2. experimental.chat.system.transform
   → 读 memory_graph → output.system.push(memorySummary)
   → LLM 系统提示中包含进化记忆上下文

3. bash("npm test") → exitCode=1
   → tool.execute.after → buildSignal → queue.push

4. queue callback:
   → deriveObservationsWithEvolver:
     → signalToEvolverEntry → appendMemoryGraph
     → spawnEvolver({ command: "run" })
     → readMemoryGraph → evolverGEPObservations
   → state.appendObservations(observations)

5. bash("npm install") → tool.execute.before
   → pickAdvisories(session + project observations)
   → pendingAdvisories.set(callID, chosen)

6. tool.execute.after → append advisory to tool output
   → LLM 看到建议：避免重复失败模式

7. session.idle
   → appendMemoryGraph(session_end entry)
   → spawnEvolver({ command: "run" })
```

### 场景 2: Evolver 不可用 — Fallback 模式

```
1. experimental.chat.system.transform
   → isEvolverAvailable() → false
   → 读本地 session + project observations
   → output.system.push(本地 observation 摘要)

2. bash("npm test") × 3 次连续失败
   → deriveObservationsWithEvolver → fallback → deriveObservations
   → repeat_failure rule 匹配 → Observation{type=repeat_failure}

3. bash("npm install") → before
   → pickAdvisories → 注入 advisory
```

### 场景 3: Session Compaction 上下文保留

```
1. Session 运行一段时间，积累了 observations
2. OpenCode 触发 compaction:
   → experimental.session.compacting
   → 读 session observations (最近 10) + project observations (最近 5)
   → 如果 evolver 可用，追加上 memory_graph 摘要
   → output.context.push(全部 parts)
3. Compaction 后，关键 observation 信息被保留在上下文中
```

---

## H) 保护机制

| 机制 | 实现 | 位置 |
|---|---|---|
| Fail-open | 全部 hook handlers 包裹在 `failOpen()` try-catch 中 | evomap.ts |
| 熔断器 | 连续 `internalErrorThreshold` 次错误后 `disabled = true` | evomap.ts |
| 防自激 | synthetic sentinel 检测，advisory 输出不进入信号队列 | evomap.ts + advisory.ts |
| 冷却时间 | 同一 advisory 两次注入间隔 ≥ `advisoryCooldownMs` | advisory.ts |
| 使用上限 | 每个 advisory 最多使用 `maxAdvisoryUses` 次 | advisory.ts |
| 每次上限 | 每次工具调用最多注入 `maxAdvisoriesPerCall` 条 | advisory.ts |
| 超时保护 | evolver spawn 超时 `evolverSpawnTimeoutMs` 后终止 | spawn.ts |
| 自动降级 | evolver 不可用时自动 fallback 到本地规则 | evolver.ts |

---

## I) 当前限制

| 限制 | 原因 |
|---|---|
| 不做 repo 级自动规则落盘 | 需人工确认流程 |
| 不接外部 mailbox / worker / Hub | 增加外部依赖 |
| advisory 追加到工具输出末尾 | OpenCode hook 机制限制 |
| evolver `setup-hooks` 不支持 OpenCode | 等上游支持 |

---

## J) 后续可扩展方向

| 方向 | 说明 |
|---|---|
| Hub / Proxy / skill store 网络能力 | 接入 EvoMap 生态 |
| Repo-candidate 人工审核流程 | 高置信度 pattern 提升到 `.evomap/` |
