# Contributing

Thanks for helping improve Palmier Pro Windows. This project is early alpha, so focused changes with tests are much more useful than broad rewrites.

## Development Prerequisites

- Windows 10/11
- Node.js 22.12 or newer
- npm
- FFmpeg and ffprobe on your `PATH`
- Rust stable toolchain
- Git

## Installation

```bash
npm install
npm run build:rust
```

## Running Locally

```bash
npm run dev
```

For the Electron shell:

```bash
npm run dev:electron
```

## Tests And Checks

Run the TypeScript checks:

```bash
npm run typecheck
npm run lint
npm test
```

Run the Rust checks:

```bash
cd native
cargo check
cargo test
```

**A green Windows run is not evidence about Linux.** CI runs these gates twice:
`checks` on `windows-latest` and `linux` on `ubuntu-latest`, the second ending in
`dist:linux` (AppImage + deb). The `linux` job was added in the same PR that
carried the FCPXML work (PR #30), and it failed nine of its first ten runs: three
at `Install dependencies` in both jobs, three more at `Unit tests` in both, and
only then the three Linux alone could fail - `Rust tests`, because a `cargo test`
harness is not a Node host and so has nothing to link `napi_*` against, then
`Build Linux packages` twice, for the electron-builder `.desktop` shape and then
the deb maintainer field. Each fix moved the failure one stage further down the
pipeline, so the stages a Windows run never reaches are the ones to expect to
break first. Run the Linux gate locally before pushing rather than in a pull
request; the first green `linux` run was 36313354966.

## Coding Standards

- Keep TypeScript strict and prefer explicit domain types over `any`.
- Keep editor mutations behind named, undoable commands.
- Treat renderer/main IPC payloads as untrusted and validate them.
- Keep Rust native bindings small, typed, and covered by tests where practical.
- Do not introduce client-trusted score, economy, or paid-generation mutations without server-side validation.

## Branch Naming

Use short, descriptive branch names:

```text
feature/timeline-trim
fix/export-path-validation
docs/roadmap-status
security/ipc-threat-model
```

## Pull Requests

- Open an issue first for larger work.
- Keep pull requests focused.
- Include tests or explain why a change is not testable yet.
- Update docs when behavior, setup, security posture, or roadmap status changes.
- Do not claim release-ready functionality until it has integration coverage.

## Upstream-Related Issues

This repository is an independent GPL-3.0 derivative of Palmier Pro. When reporting upstream-related behavior:

- Run `npm run upstream:audit` before starting nontrivial work.
- Refresh `docs/UPSTREAM_SNAPSHOT.md` when the upstream baseline changes.
- Read and update `docs/UPSTREAM_PARITY.md` when a disposition changes.
- Link to the relevant upstream issue or commit when available.
- Clearly mark whether the issue affects upstream Palmier Pro, this Windows rebuild, or both.
- State how the upstream behavior maps into the Windows domain owner, IPC boundary, undo path, preview/export path, and tests.
- Do not imply affiliation with Palmier, Inc.

## GPL Attribution

Preserve GPL attribution and the upstream credit in `ATTRIBUTION.md`, `README.md`, and release notes. New files derived from GPL-covered upstream work must retain appropriate notices.

**A test that loads a large module graph inside a test body is charged for it
against the 5 s default.** `controller.source-placement.test.ts` was the only one
of the 47 test files that use `ToolExecutor` to reach it through `await
import(...)` inside a test rather than a static top-level import. The other 46
paid the executor's module graph at collection time, where no test is timed, so
the cost was real for all of them and fell on this one test's budget. Measured:
the import alone is 0.7 s on an idle box and 6-12 s at 36 workers, while the
tool call it exists to exercise is 7-43 ms, so 99% of the test was module
loading. It failed at the 5 s wall in three separate tasks, never because of
the change under test, and passed under `npm test` while failing in focused
runs - the signature of contention rather than a slow test. Raising the ceiling
was measured and rejected: the real cost is 11-12 s and scales with load, so a
file-scoped timeout would have been a longer symptom rather than a fix. Import
at the top, as the other 46 do.
