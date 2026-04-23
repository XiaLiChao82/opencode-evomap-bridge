# opencode-evomap-bridge

`opencode-evomap-bridge` is an **OpenCode plugin** that bridges OpenCode with the official `@evomap/evolver` CLI. It observes tool execution behavior through OpenCode's stable hooks, forwards signals to evolver for evolutionary analysis, and converts evolver-produced observations into consumable advisories for subsequent tool calls.

When the evolver CLI is unavailable, it automatically falls back to the built-in local rule engine.

---

## Features

- **evolver CLI integration**: Signals are written to evolver's `memory_graph.jsonl`, triggering GEP evolutionary analysis via `evolver run`
- **Automatic fallback**: Degrades gracefully to local rules (`repeat_failure` / `repeat_success` / `slow_execution`) when evolver is unavailable
- **Session lifecycle**: `session.created` injects evolution memory; `session.idle` triggers session-end entry and writes results
- **Doctor diagnostic utility**: Checks evolver installation, memory_graph read/write access, plugin registration, and configuration validity
- **Stable hooks**: `tool.execute.before` / `tool.execute.after` + `event`
- **System prompt injection**: Injects evolver evolution memory into system prompt via `experimental.chat.system.transform`
- **Session compaction context preservation**: Retains observations and memory during compaction via `experimental.session.compacting`
- **Session / project** two-level state management
- **Safety mechanisms**: fail-open, anti-feedback-loop, cooldown, usage caps

---

## Architecture

```
OpenCode Plugin (Adapter Layer)
  │
  ├─ event(session.created) ─→ Read evolver memory_graph → Inject evolution memory
  │
  ├─ experimental.chat.system.transform ─→ Inject evolution memory into system prompt
  │
  ├─ tool.execute.after ─→ buildSignal() → queue
  │                                         │
  │                             onSignal(signal, directory):
  │                               ├─ state.appendSignal()
  │                               └─ deriveObservationsWithEvolver():
  │                                   ├─ evolver available?
  │                                   │   ├─ signal → memory_graph.jsonl
  │                                   │   ├─ spawn evolver run
  │                                   │   └─ read back GEP observations
  │                                   └─ fallback → local deriveObservations()
  │
  ├─ tool.execute.before ←─ Read observations → Select advisory
  │
  ├─ experimental.session.compacting ─→ Preserve observations + memory in compaction context
  │
  └─ event(session.idle) ─→ Construct session-end entry → Write to memory_graph
```

---

## Project Structure

```text
.opencode/plugin/evomap.ts   # Plugin entry (hooks + event registration)
src/
  spawn.ts                   # evolver CLI detection, spawn, timeout handling
  bridge.ts                  # OpenCode signal ↔ evolver format conversion
  evolver.ts                 # deriveObservationsWithEvolver + local fallback
  doctor.ts                  # Diagnostic utility (evolver, memory_graph, config)
  advisory.ts                # Advisory selection, marking, rendering
  state.ts                   # Session / project two-level state management
  queue.ts                   # Async signal queue
  config.ts                  # Default configuration
  types.ts                   # Core type definitions
  util.ts                    # Utility functions
tests/
  evolver.test.ts            # Local observation rule tests
  state.test.ts              # State management tests
  bridge.test.ts             # Format conversion + spawn tests
  doctor.test.ts             # Diagnostic utility tests
BLUEPRINT.md                 # Original design draft (historical)
```

---

## Installation

### Prerequisites

```bash
# Install evolver CLI
npm install -g @evomap/evolver
```

### Option 1: Local Plugin Path

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-evomap-bridge/.opencode/plugin/evomap.ts"
  ]
}
```

### Option 2: npm Package

```bash
npm install opencode-evomap-bridge
```

```json
{
  "plugin": ["opencode-evomap-bridge"]
}
```

### Option 3: Local tarball

```bash
npm pack                    # produces opencode-evomap-bridge-0.1.0.tgz
npm install /path/to/opencode-evomap-bridge-0.1.0.tgz
```

---

## Configuration

The plugin works out of the box with default configuration. Evolver-related settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `evolverBinary` | `"evolver"` | evolver CLI binary name |
| `evolverSpawnTimeoutMs` | `5000` | evolver spawn timeout (ms) |
| `evolverFallbackToLocal` | `true` | Fall back to local rules when evolver is unavailable |

General settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable/disable the plugin |
| `maxRecentSignals` | `50` | Max recent signals retained per session |
| `maxAdvisoriesPerCall` | `2` | Max advisories injected per tool call |
| `maxAdvisoryUses` | `3` | Max times each advisory can be used |
| `advisoryCooldownMs` | `120000` | Advisory cooldown period (2 min) |
| `repeatFailureThreshold` | `3` | Threshold for repeat_failure trigger |
| `repeatSuccessThreshold` | `2` | Threshold for repeat_success trigger |
| `slowExecutionMs` | `10000` | Slow execution threshold (10s) |
| `internalErrorThreshold` | `5` | Disable plugin after N consecutive errors |

---

## Doctor Diagnostic

Check evolver integration health:

```typescript
import { runDoctor, formatDoctorResult } from "opencode-evomap-bridge/doctor";

const result = await runDoctor(process.cwd());
console.log(formatDoctorResult(result));
```

Example output:

```text
=== EvoMap Bridge Doctor ===

  ✓ Evolver CLI Detection: evolver v1.69.0 found at /usr/local/bin/evolver
    → /usr/local/bin/evolver
  ⚠ Evolver Root Directory: .evomap/ directory not found (will be created on first use)
    → /path/to/project/.evomap
  ⚠ Memory Graph Access: memory_graph.jsonl not found (will be created on first use)
  ✓ Plugin Registration: Plugin file exists at .opencode/plugin/evomap.ts
  ✓ Configuration Check: Configuration valid (evolverBinary=evolver, timeout=5000ms, fallback=true)

Summary: 2 warnings
```

---

## Data Storage

### Plugin State (OpenCode side)

```text
~/.opencode/evomap-bridge/<project-hash>/
├── project-state.json
└── sessions/<session-id>.json
```

### evolver Data (EvoMap side)

```text
<project>/.evomap/
└── memory/evolution/
    └── memory_graph.jsonl
```

---

## Development

```bash
bun install
bun run typecheck
bun run test
```

---

## Tests

27 tests covering all modules:

| Test file | Coverage |
|-----------|----------|
| `tests/evolver.test.ts` | Local observation rules + advisory rendering |
| `tests/state.test.ts` | Session/project state management |
| `tests/bridge.test.ts` | Format conversion, memory_graph read/write, spawn paths |
| `tests/doctor.test.ts` | 5 diagnostic checks + formatted output |

---

## Limitations

- No repo-level automatic rule persistence
- No external mailbox / worker / Hub integration
- Advisories are appended to tool output, not prepended to model reasoning
- evolver CLI's `setup-hooks` does not officially support OpenCode platform

---

## Future Directions

- Hub / Proxy / skill store network capabilities
- Human-reviewed repo-candidate promotion workflow

---

## Design Document

Original design draft: `BLUEPRINT.md` (historical — actual implementation has diverged).
