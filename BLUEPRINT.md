# EvoMap Bridge — Implementation-Ready Blueprint

> **版本**: v0.1.0-draft  
> **日期**: 2026-04-22  
> **定位**: 工程执行稿，不是设计文档。工程师拿到即可开工。  
> **约束**: 基于 opencode 稳定 hook (`tool.execute.before` / `tool.execute.after`)；不依赖 experimental API；不自激、不污染、不阻塞。

---

## A) 插件包目录树

```
opencode-evomap-bridge/
├── package.json                    # name: "opencode-evomap-bridge", main: "src/index.ts"
├── tsconfig.json                   # strict, ESM, target ES2022
├── vitest.config.ts                # 单测配置
│
├── src/
│   ├── index.ts                    # 插件入口：registerHooks() + 导出公开类型
│   │
│   ├── hooks/
│   │   ├── before.ts               # tool.execute.before handler
│   │   ├── after.ts                # tool.execute.after handler
│   │   └── hook-registry.ts        # 将 before/after 绑定到 opencode hook 系统的胶水
│   │
│   ├── signals/
│   │   ├── collector.ts            # 从 after hook 原始上下文提取 RawToolSignal
│   │   ├── normalizer.ts           # 标准化工具名、提取 exitCode/duration/outputDigest
│   │   └── types.ts                # RawToolSignal, ToolName (union), SignalVerb (enum)
│   │
│   ├── evolver/
│   │   ├── queue.ts                # Async in-memory queue (microtask-based, 不用外部依赖)
│   │   ├── engine.ts               # 主循环：dequeue signal → match rule → emit observation
│   │   ├── rules/
│   │   │   ├── index.ts            # rule registry, 按顺序导出所有 rule
│   │   │   ├── repeat-failure.ts   # 规则：同一工具连续失败 N 次
│   │   │   ├── repeat-success.ts   # 规则：同一模式连续成功（可复用 pattern）
│   │   │   ├── slow-execution.ts   # 规则：执行时长超过阈值
│   │   │   └── cross-tool-seq.ts   # 规则：工具序列模式检测 (MVP 后期)
│   │   └── types.ts                # EvolveRule, EvolveResult, ObservationType
│   │
│   ├── state/
│   │   ├── session-store.ts        # SessionState 读写（内存 + JSON 持久化）
│   │   ├── project-store.ts        # ProjectState 读写（~/.opencode/evomap/ 下）
│   │   ├── repo-candidate.ts       # repo-candidate 只读展示 + 人工提升接口
│   │   └── types.ts                # SessionState, ProjectState, RepoCandidate
│   │
│   ├── advisory/
│   │   ├── composer.ts             # Observation → ExecutionAdvisory 的转换逻辑
│   │   ├── budget.ts               # 每个 session 的 advisory 预算控制（max count + cooldown）
│   │   ├── dedup.ts                # 去重：同一 advisory 在 N 条内不重复注入
│   │   └── types.ts                # ExecutionAdvisory, AdvisoryBudget, InjectionPolicy
│   │
│   ├── injection/
│   │   ├── prefix-builder.ts       # 将 advisory 编码为 system prompt 前缀文本
│   │   ├── synthetic-guard.ts      # 防回流：标记 advisory 来源，避免被 collector 误采
│   │   └── formatter.ts            # advisory 文本格式化（人可读 + machine-parseable）
│   │
│   ├── recovery/
│   │   ├── fail-open.ts            # 全局 try-catch：任何内部错误静默吞掉 + warn log
│   │   ├── circuit-breaker.ts      # 连续内部错误 N 次后自动禁用整个插件
│   │   └── health.ts               # 简易心跳：记录处理 signal 数 / advisory 数 / error 数
│   │
│   ├── config/
│   │   ├── defaults.ts             # 默认配置值
│   │   ├── schema.ts               # 配置 schema（用于运行时校验）
│   │   └── types.ts                # EvoMapConfig 类型
│   │
│   └── util/
│       ├── logger.ts               # 结构化 logger（console 为底，可接 opencode log）
│       ├── clock.ts                # monotonic timestamp helper
│       └── hash.ts                 # outputDigest 等用的小型 hash（djb2/fnv）
│
├── data/
│   └── README.md                   # 说明运行时数据目录布局（见 E 节）
│
├── tests/
│   ├── unit/
│   │   ├── signals/                # collector, normalizer 测试
│   │   ├── evolver/                # 每个 rule 的纯逻辑测试
│   │   ├── state/                  # store 读写测试（用 tmpdir）
│   │   ├── advisory/               # budget, dedup 测试
│   │   └── injection/              # synthetic-guard, prefix-builder 测试
│   ├── integration/
│   │   ├── hook-flow.test.ts       # 模拟 before→tool→after 全链路
│   │   └── budget-cap.test.ts      # 预算耗尽后的行为验证
│   └── fixtures/
│       ├── sample-signals.ts       # 预构造的 RawToolSignal fixtures
│       └── sample-advisories.ts    # 预构造的 ExecutionAdvisory fixtures
│
├── docs/
│   ├── architecture.md             # 从本 blueprint 生成，供新人阅读
│   └── changelog.md                # 变更日志
│
└── scripts/
    └── gen-types-doc.ts            # 从类型定义生成 markdown 文档（可选）
```

---

## B) 模块文件职责说明

| 文件 | 职责 | 输入 | 输出 | 副作用 |
|---|---|---|---|---|
| **index.ts** | 插件注册入口。调用 `registerHooks()`，导出所有公开类型。 | opencode hook API | 无 | 注册 before/after handler |
| **hooks/before.ts** | 拦截即将执行的工具调用。读取 session state，组装 advisory prefix，注入到 prompt context。 | tool name, args, session state | advisory text (string \| null) | 无 |
| **hooks/after.ts** | 拦截工具执行结果。提取原始信号，push 到 evolver queue。 | tool name, args, result, duration, exitCode | 无 | enqueue signal |
| **hooks/hook-registry.ts** | 胶水层：将 before/after 函数绑定到 opencode 的 `tool.execute.before` / `tool.execute.after`。 | opencode hook 注册函数 | 无 | 注册 hook |
| **signals/collector.ts** | 从 after hook 的原始上下文构造 `RawToolSignal`。调用 normalizer 标准化。 | after hook context | `RawToolSignal` | 无 |
| **signals/normalizer.ts** | 标准化工具名（映射 alias）、提取关键字段、计算 outputDigest。 | raw tool name, output string | 标准化字段 | 无 |
| **signals/types.ts** | 定义 `RawToolSignal`, `ToolName` (union type), `SignalVerb` (enum)。 | — | — | 无 |
| **evolver/queue.ts** | 内存异步队列。`push(signal)` 入队，内部 microtask 循环消费。 | `RawToolSignal` | 无 | 触发 engine.process |
| **evolver/engine.ts** | dequeue signal → 遍历 rules → 收集 matching results → 写入 state store。 | dequeued signal | `Observation[]` | 写 store |
| **evolver/rules/*.ts** | 纯函数 rule：输入 `(signal, history, config)` → 输出 `EvolveResult \| null`。 | signal + 历史信号 | observation 或 null | 无 |
| **evolver/types.ts** | `EvolveRule` interface, `EvolveResult`, `ObservationType` enum。 | — | — | 无 |
| **state/session-store.ts** | 当前 session 的 observation/advisory 历史。内存持有 + 退出时 JSON 落盘。 | read/write ops | `SessionState` | 读写文件 |
| **state/project-store.ts** | 跨 session 的 project 级累积 patterns。持久化在 `~/.opencode/evomap/<project>/`。 | read/write/merge ops | `ProjectState` | 读写文件 |
| **state/repo-candidate.ts** | 从 project state 中筛选可提升到 repo 级的 pattern。只展示 + 确认后写入 `.evomap/`。 | project state | candidate 列表 | 需人工确认才写 |
| **advisory/composer.ts** | 将 `Observation` 转换为 `ExecutionAdvisory`：选择模板、填充变量、计算优先级。 | `Observation` | `ExecutionAdvisory` | 无 |
| **advisory/budget.ts** | 维护当前 session 的 advisory 注入计数。超限则返回 `budgetExhausted`。 | session ID, advisory type | allow/deny | 无 |
| **advisory/dedup.ts** | 相同（或高度相似）advisory 在滑动窗口 N 条内不重复注入。 | advisory fingerprint | allow/deny | 无 |
| **injection/prefix-builder.ts** | 将通过 budget+dedup 的 advisory 列表拼接为 system prompt 前缀文本。 | `ExecutionAdvisory[]` | string | 无 |
| **injection/synthetic-guard.ts** | 给 advisory 文本加 sentinel 标记（如 `<!-- evomap:advisory:id=xxx -->`），确保 collector 不会把 advisory 文本误采为 signal。 | advisory text | marked text | 无 |
| **injection/formatter.ts** | 将 advisory 格式化为对 LLM 友好的文本块。 | `ExecutionAdvisory` | string | 无 |
| **recovery/fail-open.ts** | 高阶 wrapper：`withFailOpen(fn)` — catch 任何错误，log warn，返回 fallback。 | 任意 async fn | wrapped fn | log |
| **recovery/circuit-breaker.ts** | 计数连续内部错误。超过阈值（默认 5）则跳过所有后续 hook 调用。 | error events | trip/reset | log |
| **recovery/health.ts** | 暴露 `getHealth()` 返回 `{signalsProcessed, advisoriesEmitted, errors, circuitState}`。 | — | HealthReport | 无 |
| **config/defaults.ts** | 默认配置值对象。 | — | `EvoMapConfig` | 无 |
| **config/schema.ts** | 运行时校验用户覆盖配置（如果 opencode 支持插件配置）。 | partial config | validated config | throw on invalid |

---

## C) Hook 串联顺序图

```
用户发起工具调用
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  tool.execute.before hook                                │
│                                                          │
│  1. [read]  sessionStore.getAdvisories(toolName)         │
│  2. [check] budget.allow(sessionId, advisoryType)        │
│  3. [check] dedup.allow(advisoryFingerprint)             │
│  4. [build] prefixBuilder.build(approvedAdvisories)      │
│  5. [guard] syntheticGuard.mark(prefixText)              │
│  6. [inject] 返回 prefixText 给 opencode 注入 prompt     │
│     (如果 prefixText === null → 不注入，透传)            │
└─────────────────────────────────────────────────────────┘
     │
     ▼  (opencode 执行实际工具)
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  tool.execute.after hook                                 │
│                                                          │
│  1. [collect] collector.fromContext(hookContext)          │
│  2. [normalize] normalizer.normalize(rawSignal)           │
│  3. [guard] 如果 output 包含 synthetic sentinel → 跳过   │
│     (防止自激：不把 advisory 输出当作真实 signal)         │
│  4. [enqueue] evolverQueue.push(normalizedSignal)         │
│  5. [return] 立即返回，不阻塞工具结果返回                │
└─────────────────────────────────────────────────────────┘
     │
     ▼  (异步，不阻塞用户)
┌─────────────────────────────────────────────────────────┐
│  Evolver Engine (microtask loop)                         │
│                                                          │
│  1. [dequeue] 从 queue 取出 signal                       │
│  2. [match]  遍历 rules，收集 matching results           │
│  3. [write]  sessionStore.appendObservations(results)     │
│  4. [merge]  projectStore.mergeFromSession(sessionId)    │
│     (有 cooldown，不是每次都 merge)                       │
│  5. [health] healthTracker.record('signalProcessed')     │
└─────────────────────────────────────────────────────────┘
     │
     ▼  (下次 before hook 时消费)
┌─────────────────────────────────────────────────────────┐
│  Advisory 组装 (在 before hook 中执行)                   │
│                                                          │
│  1. sessionStore 的 observations → composer.transform    │
│  2. 过滤：budget + dedup + cooldown                      │
│  3. prefixBuilder → syntheticGuard → inject              │
└─────────────────────────────────────────────────────────┘
```

**关键时序保证**：
- after hook 必须 **同步返回**（或极短异步），不阻塞工具结果
- evolver 全部 **异步**，在 microtask/nextTick 中执行
- before hook 读取的是 **上一轮** evolver 写入的 state，不存在读写竞争（因为 evolver 在 after 后的 microtask 已完成）

---

## D) 核心类型草图（字段级）

```typescript
// ─── signals/types.ts ───

/** 已知工具名 union，未知工具统一为 "unknown" */
type ToolName =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "glob"
  | "grep"
  | "lsp_diagnostics"
  | "lsp_goto_definition"
  | "webfetch"
  | "unknown";

/** 信号动词 */
type SignalVerb = "execute";

/** 工具执行的原始信号 */
interface RawToolSignal {
  id: string;                    // uuid v4
  timestamp: number;             // performance.now() monotonic
  wallTime: string;              // ISO 8601
  tool: ToolName;
  verb: SignalVerb;              // MVP 只有 "execute"
  args: {
    command?: string;            // bash: 完整命令
    filePath?: string;           // read/write/edit
    pattern?: string;            // glob/grep
    raw: Record<string, unknown>; // 原始参数的浅拷贝
  };
  result: {
    exitCode: number | null;     // bash: exit code; 其他工具: 0=成功, 1=失败, null=未知
    success: boolean;
    durationMs: number;
    outputDigest: string;        // fnv1a hash of output string, 用于去重，不存原始内容
    outputLineCount: number;     // 输出行数（不含内容）
    errorSnippet: string | null; // 如果失败，截取前 200 字符的错误信息
  };
  sessionId: string;             // 当前 session ID
  projectId: string;             // 当前 project hash（基于 cwd）
}

// ─── evolver/types.ts ───

/** Observation 类型 */
enum ObservationType {
  REPEAT_FAILURE = "repeat_failure",       // 同一工具+相似参数连续失败
  REPEAT_SUCCESS = "repeat_success",       // 同一模式连续成功
  SLOW_EXECUTION = "slow_execution",       // 执行时长异常
  CROSS_TOOL_SEQUENCE = "cross_tool_seq",  // 工具序列模式
}

/** 一次观察 */
interface Observation {
  id: string;                    // uuid
  type: ObservationType;
  tool: ToolName;
  fingerprint: string;           // 观察的唯一指纹（用于去重）
  evidence: {
    signalIds: string[];         // 关联的原始信号 ID（最多保留最近 10 个）
    firstSeen: string;           // ISO 8601
    lastSeen: string;            // ISO 8601
    occurrenceCount: number;     // 出现次数
  };
  context: {
    pattern: string;             // 人类可读的模式描述，如 "bash: npm test 连续失败 3 次"
    argsFingerprint: string;     // 参数指纹（hash）
    avgDurationMs: number;       // 平均耗时
    lastErrorSnippet: string | null;
  };
  confidence: number;            // 0.0 - 1.0
  sessionId: string;
  createdAt: string;             // ISO 8601
}

/** Evolve rule 接口 */
interface EvolveRule {
  name: string;
  observationType: ObservationType;
  /** 纯函数：输入信号 + 历史观察 → 如果匹配则返回 result，否则 null */
  evaluate: (signal: RawToolSignal, history: Observation[], config: EvoMapConfig) => EvolveResult | null;
}

/** Rule 匹配结果 */
interface EvolveResult {
  observation: Observation;       // 新的或更新的 observation
  shouldPersist: boolean;        // 是否写入 store
}

// ─── advisory/types.ts ───

/** 执行建议 */
interface ExecutionAdvisory {
  id: string;                    // uuid
  observationId: string;         // 关联的 observation
  type: ObservationType;         // 继承 observation 的类型
  priority: number;              // 1-5, 5=最高
  targetTools: ToolName[];       // 此 advisory 适用的工具列表
  title: string;                 // 简短标题，如 "bash 连续失败模式检测"
  body: string;                  // 详细的建议文本（LLM 可理解的自然语言）
  actionHint: string | null;     // 可选的行动提示，如 "建议先运行 npm install"
  fingerprint: string;           // 去重指纹
  injectedAt: string[];          // 注入历史（timestamp list，用于 cooldown）
  metadata: {
    confidence: number;
    occurrenceCount: number;
    sourceLevel: "session" | "project";
  };
}

/** 注入预算 */
interface AdvisoryBudget {
  maxPerSession: number;         // 每个 session 最多注入 N 条 advisory（默认 20）
  maxPerTool: number;            // 每个工具每次调用最多注入 N 条（默认 2）
  cooldownMs: number;            // 同一 advisory 两次注入的最小间隔（默认 60000ms）
  reuseCap: number;              // 同一 advisory 在 session 内最多复用 N 次（默认 3）
}

/** 注入策略 */
interface InjectionPolicy {
  budget: AdvisoryBudget;
  dedupWindowSize: number;       // 滑动窗口大小（最近 N 条 advisory 内去重，默认 5）
  maxPrefixChars: number;        // 注入前缀最大字符数（默认 500）
}

// ─── state/types.ts ───

/** Session 级状态 */
interface SessionState {
  sessionId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  signals: {
    recent: RawToolSignal[];     // 最近 N 条信号（默认 50），FIFO
    totalCount: number;
  };
  observations: Observation[];
  advisories: {
    history: ExecutionAdvisory[]; // 已注入的 advisory 历史
    injectedCount: number;        // 当前 session 已注入总数
    budgetRemaining: number;      // 剩余预算
  };
  health: {
    errorsCount: number;
    lastError: string | null;
    circuitBreakerTripped: boolean;
  };
}

/** Project 级状态（跨 session 累积） */
interface ProjectState {
  projectId: string;
  projectPath: string;           // 原始 cwd path
  version: number;               // schema version，用于迁移
  updatedAt: string;
  patterns: {
    failures: Observation[];     // 从多个 session 积累的失败模式
    successes: Observation[];    // 成功复用模式
    slowTools: Observation[];    // 慢执行记录
  };
  stats: {
    totalSessions: number;
    totalSignals: number;
    totalObservations: number;
  };
  repoCandidates: RepoCandidate[];
}

/** Repo 级候选（需人工确认才落盘） */
interface RepoCandidate {
  id: string;
  observationId: string;
  type: ObservationType;
  pattern: string;               // 人类可读描述
  proposedContent: string;       // 建议写入 .evomap/ 的内容
  sourceSessions: string[];      // 来源 session 列表
  occurrenceCount: number;
  confidence: number;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

// ─── config/types.ts ───

interface EvoMapConfig {
  enabled: boolean;              // 全局开关（默认 true）
  logLevel: "debug" | "info" | "warn" | "error";  // 默认 "warn"
  
  hooks: {
    before: {
      enabled: boolean;          // 默认 true
    };
    after: {
      enabled: boolean;          // 默认 true
    };
  };
  
  evolver: {
    rules: {
      repeatFailure: {
        enabled: boolean;        // 默认 true
        threshold: number;       // 连续失败次数阈值（默认 3）
        windowMs: number;        // 时间窗口（默认 300000ms = 5min）
      };
      repeatSuccess: {
        enabled: boolean;        // 默认 true
        threshold: number;       // 默认 3
        windowMs: number;        // 默认 300000ms
        reuseCap: number;        // 同一成功模式最多推荐 N 次（默认 3）
      };
      slowExecution: {
        enabled: boolean;        // 默认 true
        thresholdMs: number;     // 默认 30000ms（30 秒）
        toolOverrides: Partial<Record<ToolName, number>>; // 每个工具可覆盖
      };
      crossToolSequence: {
        enabled: boolean;        // 默认 false（MVP 不启用）
      };
    };
  };
  
  state: {
    session: {
      maxRecentSignals: number;  // 内存中保留的最近信号数（默认 50）
      persistOnExit: boolean;    // 退出时是否落盘（默认 true）
    };
    project: {
      maxPatterns: number;       // 每类 pattern 最大数量（默认 100）
      mergeCooldownMs: number;   // session→project merge 冷却时间（默认 60000ms）
      persistPath: string;       // 默认 "~/.opencode/evomap"
    };
  };
  
  advisory: {
    injectionPolicy: InjectionPolicy;
    templates: {
      /** 自定义模板覆盖，key = ObservationType */
      [K in ObservationType]?: string;  // Handlebars-style template
    };
  };
  
  recovery: {
    failOpen: boolean;           // 默认 true
    circuitBreaker: {
      enabled: boolean;          // 默认 true
      threshold: number;         // 连续错误阈值（默认 5）
      resetMs: number;           // 自动恢复时间（默认 60000ms）
    };
  };
}

// ─── recovery/types.ts ───

interface HealthReport {
  signalsProcessed: number;
  advisoriesEmitted: number;
  errors: number;
  circuitState: "closed" | "open" | "half-open";
  lastError: string | null;
  uptime: number;                // ms since plugin load
}
```

---

## E) 状态文件/数据目录布局

```
~/.opencode/
├── evomap/
│   ├── config.json                          # 用户覆盖配置（可选）
│   ├── health.json                          # 最近一次 health report
│   │
│   ├── projects/
│   │   ├── <project-hash-1>/                # hash = fnv1a(cwd)
│   │   │   ├── project-state.json           # ProjectState 持久化
│   │   │   ├── sessions/
│   │   │   │   ├── <session-id-1>.json      # 历史 SessionState（已结束）
│   │   │   │   ├── <session-id-2>.json
│   │   │   │   └── ...
│   │   │   └── repo-candidates.json         # RepoCandidate[] 持久化
│   │   │
│   │   └── <project-hash-2>/
│   │       └── ...
│   │
│   └── _current-session.json                # 当前活跃 session 的状态（实时写入）
│
│
# Repo 级（项目根目录，需要人工确认后才存在）
<project-root>/
├── .evomap/                                 # 仅当用户手动 approve 后才创建
│   ├── README.md                            # 说明此目录用途
│   ├── patterns.json                        # 团队共享的已确认 patterns
│   └── advisories.json                      # 团队共享的 advisory 模板
└── ... (项目其他文件)
```

**关键规则**：
1. `.evomap/` 目录 **永远不会被插件自动创建**。只有用户通过明确指令 approve 后才写入。
2. `project-state.json` 只在 **session 结束时** merge，不在每次 signal 后写入。
3. `_current-session.json` 在每次 evolver 处理完信号后异步写入（debounced 1s）。
4. 历史 session 文件按 session ID 命名，插件启动时可选择加载最近 N 个用于 cold-start。

---

## F) MVP 逐步落地顺序

> 按**真正开发顺序**排列，每步有明确的 "done when" 验收条件。

### Step 1: 脚手架 + 类型定义
- 初始化 npm 包、tsconfig、vitest
- 创建 `src/` 目录结构（空文件 + export）
- 写入所有 `types.ts` 文件（D 节中的类型定义）
- **Done when**: `tsc --noEmit` 通过，vitest 能跑空测试

### Step 2: 信号采集链路（signals/ + hooks/after）
- 实现 `signals/normalizer.ts`（纯函数 + 单测）
- 实现 `signals/collector.ts`（依赖 normalizer + 单测）
- 实现 `hooks/after.ts`（调用 collector → enqueue）
- **Done when**: 给定 mock after context，能输出正确的 `RawToolSignal`，单测全绿

### Step 3: 内存队列 + Evolver 骨架（evolver/queue + engine）
- 实现 `evolver/queue.ts`（push + 内部 microtask 消费）
- 实现 `evolver/engine.ts` 骨架（dequeue → log → discard，暂不接 rules）
- **Done when**: queue push 后 engine 能收到 signal，单测验证

### Step 4: 第一条 Rule — repeat-failure
- 实现 `evolver/rules/repeat-failure.ts`
- 接入 engine：dequeue → rule.evaluate → 输出 observation
- **Done when**: 连续 3 个 bash 失败 signal → 产生 `REPEAT_FAILURE` observation，单测验证

### Step 5: Session Store + State 持久化
- 实现 `state/session-store.ts`（内存 + JSON 落盘）
- 实现 `state/project-store.ts`（读写 project-state.json）
- 接入 engine：observation → sessionStore → projectStore
- **Done when**: evolver 产生 observation 后 session JSON 文件正确更新

### Step 6: Advisory 组装 + 注入（advisory/ + injection/）
- 实现 `advisory/composer.ts`（observation → advisory）
- 实现 `advisory/budget.ts` + `advisory/dedup.ts`
- 实现 `injection/prefix-builder.ts` + `injection/synthetic-guard.ts` + `injection/formatter.ts`
- **Done when**: 给定 observation，能输出带 sentinel 标记的 advisory 文本

### Step 7: Before Hook 消费（hooks/before）
- 实现 `hooks/before.ts`（读 state → 过滤 → 组装 prefix → 返回）
- **Done when**: 给定 session state 中有 observation，before hook 能返回正确的 advisory prefix

### Step 8: Hook 注册 + 集成测试
- 实现 `hooks/hook-registry.ts`
- 实现 `index.ts` 入口
- 写 `integration/hook-flow.test.ts`
- **Done when**: 模拟完整的 before→tool→after→evolver→before 链路，端到端验证

### Step 9: Fail-Open + Circuit Breaker
- 实现 `recovery/fail-open.ts`
- 实现 `recovery/circuit-breaker.ts`
- 实现 `recovery/health.ts`
- 包装所有 hook handler 和 evolver
- **Done when**: 内部抛错时 hook 仍正常返回、连续 5 次内部错误后插件自动禁用

### Step 10: 第二条 Rule — repeat-success
- 实现 `evolver/rules/repeat-success.ts`
- 实现 reuse cap 逻辑
- **Done when**: 连续 3 次相同模式成功 → 产生 `REPEAT_SUCCESS` observation → advisory 有 reuse cap

### Step 11: 第三条 Rule — slow-execution
- 实现 `evolver/rules/slow-execution.ts`
- **Done when**: 工具执行超过阈值 → 产生 `SLOW_EXECUTION` observation

### Step 12: Config 系统
- 实现 `config/defaults.ts` + `config/schema.ts`
- 所有模块改为从 config 读取阈值
- **Done when**: 用户可在 `~/.opencode/evomap/config.json` 覆盖默认值

### Step 13: Repo Candidate 展示（只读）
- 实现 `state/repo-candidate.ts`（只从 project state 筛选，不自动写入）
- **Done when**: 高置信度 pattern 出现在 candidate 列表中，但不会自动落盘

### Step 14: Polish + 文档
- 补充边界测试、错误路径测试
- 生成 `docs/architecture.md`
- **Done when**: 测试覆盖率 > 80%，文档与代码一致

---

## G) 端到端示例场景

### 场景 1: Bash 连续失败

```
时间线:
T1  user 调用 bash("npm test")        → exitCode=1,  收集 signal S1
T2  user 调用 bash("npm test")        → exitCode=1,  收集 signal S2
T3  user 调用 bash("npm test")        → exitCode=1,  收集 signal S3

Evolver (T3 后异步):
  - repeat-failure rule 匹配 (3次连续失败, tool=bash, argsFingerprint=hash("npm test"))
  - 写入 SessionState.observations: Observation{type=REPEAT_FAILURE, pattern="bash: npm test 连续失败 3 次"}

T4  user 调用 bash("npm install")     → before hook 触发
Before Hook:
  - sessionStore 有 REPEAT_FAILURE observation (targetTool includes "bash")
  - budget.check → allow (剩余 19/20)
  - dedup.check → allow (窗口内无相同 fingerprint)
  - compose advisory:
    title: "bash 连续失败模式检测"
    body: "过去 5 分钟内 'npm test' 命令连续失败 3 次。可能原因：依赖未安装、测试环境异常。"
    actionHint: "建议先运行 npm install 确认依赖完整"
  - prefixBuilder → syntheticGuard.mark → 注入 system prompt 前缀
  
结果: LLM 在执行 bash("npm install") 前看到了关于 npm test 失败的上下文提示，
      可能在执行后主动建议运行 npm test 验证。
```

### 场景 2: 文件编辑成功复用

```
时间线:
T1  user 调用 edit("src/foo.ts", oldStr="v1", newStr="v2")  → success
T2  user 调用 edit("src/bar.ts", oldStr="v1", newStr="v2")  → success  
T3  user 调用 edit("src/baz.ts", oldStr="v1", newStr="v2")  → success

Evolver (T3 后异步):
  - repeat-success rule 匹配 (3次相同替换模式)
  - 写入 Observation{type=REPEAT_SUCCESS, pattern="edit: 批量替换 'v1'→'v2'"}

T4  user 调用 edit("src/qux.ts", ...)  → before hook
Before Hook:
  - 有 REPEAT_SUCCESS observation
  - advisory: "检测到批量替换模式 'v1'→'v2'，当前 session 已成功执行 3 次。
               如果 qux.ts 包含相同内容，建议使用相同替换策略。"
  - reuseCap 检查: 已注入 1 次，cap=3，allow
  - 注入 advisory

结果: LLM 收到上下文提示，可能在 edit 前先 read 文件确认内容。
```

### 场景 3: 无 Adapter 场景（降级模式）

```
前提: opencode 版本不支持插件 hook，或者 hook 注册失败

启动时:
  - hook-registry 尝试注册 → 失败/抛错
  - fail-open 包装：catch error, log warn "hook 注册失败，evomap 进入 passive 模式"
  - circuitBreaker.trip()

后续所有工具调用:
  - before hook: 不触发（未注册成功）
  - after hook: 不触发
  - 用户无感知，opencode 正常工作

Health:
  getHealth() → {circuitState: "open", errors: 1, ...}
```

### 场景 4: 预算耗尽

```
时间线:
T1-T25  连续 20 次不同 pattern 触发 advisory，注入预算耗尽

T26  before hook 触发:
  - budget.check → deny (剩余 0/20)
  - 返回 null，不注入任何 advisory
  - log debug: "advisory budget exhausted for session xxx"

结果: 后续工具调用不再收到任何 advisory，避免过度干扰。
```

### 场景 5: 自激防护

```
时间线:
T1  before hook 注入 advisory: "<!-- evomap:advisory:id=a1 -->建议检查依赖<!-- /evomap -->"
T2  bash 执行，output 中包含上述 advisory 文本（例如 echo 了 prompt）
T3  after hook 触发:
  - collector 从 context 提取 output
  - syntheticGuard.check(output) → 检测到 sentinel 标记
  - 跳过此 signal，不 enqueue
  
结果: advisory 不会被误采为真实信号，避免自激循环。
```

---

## H) 第一批不做

| 项目 | 原因 | 未来版本 |
|---|---|---|
| `cross-tool-seq` rule | 模式检测复杂度高，MVP 价值不明确 | v0.2 |
| `experimental.session.compacting` hook | 不稳定，可能随时变化 | 等稳定后 |
| `experimental.chat.system.transform` | 同上 | 等稳定后 |
| Repo 级 `.evomap/` 自动写入 | 明确要求人工确认 | v0.3（加 CLI 确认流程）|
| Evolver mailbox / 外部持久化队列 | 增加外部依赖，MVP 用内存队列足够 | v0.3+ |
| 跨 project 的全局 knowledge sharing | 需要额外的存储和同步机制 | v0.4+ |
| Observation 热度衰减 / 时间窗口遗忘 | 需要更复杂的 state 管理 | v0.2 |
| 自定义 rule 注册 API | 需要稳定的插件扩展机制 | v0.3 |
| Advisory 模板自定义 | 增加初始复杂度 | v0.2 |
| Web UI / 可视化 dashboard | 非 MVP 核心价值 | v0.5+ |
| 多语言 advisory（i18n） | 先做英文，后续加中文 | v0.2 |
| 性能 profiling / benchmark | 先确保功能正确 | v0.3 |
| Plugin 热更新 | 增加复杂度 | v0.4+ |

---

## I) 进入真实 repo 后第一天清单

> 假设已 clone opencode 到本地，可以修改源码。

### 上午（环境验证）

- [ ] **1. 确认 opencode 能本地构建**
  ```bash
  cd opencode && pnpm install && pnpm build
  ```
  目标：确保基础开发环境可用。

- [ ] **2. 定位 hook 触发点**
  ```bash
  grep -rn "tool.execute.before\|tool.execute.after" packages/opencode/src/
  ```
  目标：确认 `prompt.ts` 中的 hook 调用签名、上下文参数结构。记录准确的参数类型。

- [ ] **3. 确认插件注册机制**
  ```bash
  grep -rn "plugin\|hook.*register\|useHook" packages/opencode/src/ --include="*.ts"
  ```
  目标：搞清楚插件如何注册 hook。是否存在 `registerHook()` API？还是需要 patch 源码？

- [ ] **4. 写一个最小 hook 验证**
  在 `prompt.ts` 的 `tool.execute.before` 处加一行 `console.log("[evomap-debug]", toolName, args)`。
  运行 opencode，执行一次 `bash("echo hello")`，确认 console 输出。
  目标：验证 hook 能被拦截且不影响正常功能。

- [ ] **5. 记录 hook 上下文完整结构**
  在 before/after hook 处 `JSON.stringify(context, null, 2)` 输出到文件。
  执行几种工具（bash, read, write, edit），收集完整的 context 结构。
  目标：为 collector.ts 提供精确的字段映射。

### 下午（骨架搭建）

- [ ] **6. 初始化插件包**
  在 opencode 的 packages/ 下或外部独立目录创建 `opencode-evomap-bridge/`。
  按本 blueprint A 节创建目录结构。
  写 `package.json`, `tsconfig.json`, `vitest.config.ts`。

- [ ] **7. 写入所有类型定义**
  按 D 节写入所有 `types.ts` 文件。
  `tsc --noEmit` 确认编译通过。

- [ ] **8. 实现信号采集链路（Step 2）**
  写 `signals/normalizer.ts` + `signals/collector.ts` + 单测。
  用上午收集的真实 context 结构构造测试 fixture。

- [ ] **9. 验证信号采集端到端**
  在 after hook 中实际调用 collector，将结果写入临时文件。
  执行几次工具调用，确认 JSON 输出正确。

- [ ] **10. 记录当天发现的问题**
  - hook 参数结构是否与假设一致？
  - 是否有字段缺失或类型不匹配？
  - 插件加载时机是否影响 hook 注册？
  更新 blueprint 中的类型定义。

### 当天结束时产出

```
day1-report.md:
  - opencode 版本: ...
  - hook 签名: (实际记录)
  - hook context 结构: (实际 JSON)
  - 已完成: 类型定义 + 信号采集
  - 待解决: (如果有)
  - 明天计划: Step 3-5 (queue + evolver + session store)
```

---

## 附录：关键设计约束速查表

| 约束 | 机制 | 实现位置 |
|---|---|---|
| 不阻塞工具执行 | after hook 同步返回，evolver 异步 | hooks/after.ts, evolver/queue.ts |
| 不污染 prompt | budget cap + dedup + maxPrefixChars | advisory/budget.ts, advisory/dedup.ts |
| 不自激循环 | synthetic sentinel 标记 + guard 检测 | injection/synthetic-guard.ts, hooks/after.ts |
| 不自动写 repo | repo-candidate 只展示 + 需人工 approve | state/repo-candidate.ts |
| 不崩溃影响宿主 | fail-open wrapper + circuit breaker | recovery/fail-open.ts, recovery/circuit-breaker.ts |
| 状态分层 | session > project > repo-candidate | state/*.ts |
| 预算控制 | per-session count + per-tool count + cooldown + reuse cap | advisory/budget.ts |
| 异步处理 | microtask queue，不依赖外部 lib | evolver/queue.ts |
