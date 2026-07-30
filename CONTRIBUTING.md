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
