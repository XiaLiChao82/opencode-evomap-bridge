# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2025-04-25

### Changed

- Bump version to `0.1.1`

## [0.1.0] - 2025-04-25

### Added

- **Experimental hooks**: `session.created`, `session.idle`, `experimental.chat.system.transform`, `experimental.session.compacting` integration ([`869a9f4`])
- **evolver CLI integration**: official `@evomap/evolver` CLI as observation backend with automatic local fallback ([`8161c77`])
- **Session lifecycle**: `session.created` reads evolver memory graph → inject evolution memory; `session.idle` writes session-end entries ([`a34148f`])
- **Doctor utility**: 5-point health check for evolver installation, memory graph access, plugin registration, and configuration ([`a34148f`])
- **Bridge module**: OpenCode signal ↔ evolver format conversion, memory_graph.jsonl read/write, spawn path resolution ([`8161c77`])
- **Advisory state flow**: observation derivation from tool signals, advisory selection/rendering with anti-feedback-loop sentinel, cooldown and use-limit enforcement ([`5009053`])
- **Runtime primitives**: `EvoMapState` (session/project two-level persistence), `SignalQueue` (async microtask queue), config, types, utilities ([`200a861`], [`b55c2d1`])
- **Plugin scaffold**: OpenCode plugin entry point with `tool.execute.before`/`tool.execute.after` hooks ([`b55c2d1`])
- **Test coverage**: 27 tests covering evolver rules, state management, bridge conversion, and doctor diagnostics ([`f784228`])
- **Implementation blueprint**: detailed architecture and data-flow documentation (`BLUEPRINT.md`) ([`662dfa9`])
- **npm publish config**: exports map, keywords, license field ([`42448f1`])
- **README**: full setup and usage guide with configuration examples ([`78594c7`])

### Build

- Ignore TypeScript build metadata in `.gitignore` ([`7d12ff4`])

[0.1.1]: https://github.com/XiaLiChao82/opencode-evomap-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/XiaLiChao82/opencode-evomap-bridge/releases/tag/v0.1.0
