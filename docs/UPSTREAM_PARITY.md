# Upstream Parity Policy

Palmier Pro Windows follows
[palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro) as its
product, interaction, and correctness reference. The macOS implementation is
not copied file-for-file; its behavior and invariants are translated into the
Windows architecture.

The machine-generated tracker is in
[`UPSTREAM_SNAPSHOT.md`](./UPSTREAM_SNAPSHOT.md). The older
[`UPSTREAM_ISSUES.md`](./UPSTREAM_ISSUES.md) contains detailed implementation
notes for previously audited fixes.

## Workflow

Run this before starting nontrivial work:

```bash
npm run upstream:audit
```

Refresh the tracked snapshot when upstream has moved:

```bash
npm run upstream:audit:write
```

Verify that the committed snapshot still matches upstream:

```bash
npm run upstream:audit:check
```

The audit covers:

- the latest upstream `main` commit;
- every currently open upstream issue;
- recently merged upstream pull requests;
- whether the local snapshot is current.

For a specific feature, also inspect the upstream source and tests. Issue and PR
titles are discovery aids, not sufficient implementation specifications.

## Current Baseline

- Upstream repository: `palmier-io/palmier-pro`
- Upstream branch: `main`
- Upstream baseline: `de37a5378fe269f4439c20fb88c55365b9d1c4e5`
- Baseline date: 2026-07-25
- Windows audit date: 2026-07-25

## High-Priority Parity Ledger

| Upstream | Area | Windows disposition | Windows owner / evidence |
|---|---|---|---|
| #200, #264 | Numeric frame overflow | Implemented | Zod validation, safe frame helpers, overflow regression tests |
| #211 | Crash recovery autosave | Implemented | `useAutosave`, atomic main-process recovery snapshot |
| #174, PR #175 | Remove silence | Implemented | silence detector, undoable replacement, Inspector and Agent paths |
| #98, PRs #203/#213 | Blend modes | Implemented | shared blend model, compositor, Inspector, Agent command |
| PR #353, PR #342 | Explorer/Finder files directly to timeline and linked audio placement | Implemented | Explorer and Media-panel drops share atomic sequential placement; video with probed embedded audio creates a linked audio clip on a free/unlocked lane (or an undoable new lane), and linked selection/move/trim/split/delete stay synchronized |
| PR #373 | Preview refresh after text insertion or timeline mutation | Implemented | Project revisions at the current playhead request a fresh composite immediately; renderer synchronization recomposites and per-window generations prevent stale async frames from replacing newer output |
| PR #397 | Multicam ripple synchronization | Planned | Multicam domain is not implemented |
| PR #372 | Large caption workflow responsiveness | Planned | Caption workflow is not implemented |
| PR #371, issue #212 | Preview playback speeds | Implemented | Preview toolbar exposes 0.5x, 0.75x, 1x, 1.5x, 2x, 4x, and 10x presets; transport consumes the selected transient rate |
| PR #369 | Edge rounding and softness | Planned | Not represented in the Windows clip/compositor contract |
| PR #361, issues #154/#289 | XML/FCPXML interchange and source timecode | Planned | Export interchange layer is not implemented |
| PR #337 | Serialized project-package writes | Partial | Atomic saves exist; a package-wide mutation coordinator is still needed |
| PR #331 | Centralized undo history | Implemented | Editor controller owns command history shared by renderer and main-process edits |
| Current `RippleEngine` / `EditorViewModel+Ripple` | Ripple delete and sync lock | Partial | Selected-clip ripple delete is one controller transaction, expands linked A/V, merges multiple ranges, shifts sync-locked tracks, respects edit locks, supports one-step undo/redo, and is shared by UI/Agent/MCP; range cutting, gap delete, and ripple trim remain planned |
| PR #346 | Process-wide inference serialization | Different by design | Apple MLX path is absent; Windows generation providers still require bounded job concurrency |
| PR #408 | Invert colors effect | Planned | Windows has no shared effect-stack contract yet; add through the R4 preview/export effect registry rather than a compositor-only special case |
| PR #406 | Source-video preparation and grouped video models | Partial | Windows generation providers and source inputs exist; model capability grouping and shared source preprocessing remain part of the R6 provider registry |
| PR #405 | AVAssetReader teardown off cooperative workers | N/A platform | Windows uses FFmpeg/native decoding rather than AVFoundation; decoder cancellation and teardown remain an R2 performance gate |
| PR #404 | Disable AppKit content-driven panel sizing | N/A platform | Windows uses React/Electron layout constraints; the 1600x1000 and 1024x680 no-scroll matrix covers the analogous regression |
| PR #403 | Unblock main thread when project write throws | Partial | Windows writes use asynchronous Node filesystem operations and recovery snapshots use atomic rename; explicit project save still needs the R0 atomic-write contract and failure-path test |
| PR #401 | Korean README wording | N/A platform | Upstream documentation-only localization change; no translated Windows README currently exists |
| #173 | Apple OAuth stall | N/A platform | No Clerk/ASWebAuthenticationSession path |
| #195, #220, #262 | Windows support | Implemented by project | x64 portable plus x64/arm64 installer targets |

This table is deliberately concise. Add rows whenever an upstream change is
adopted, deferred, rejected, or found to expose a Windows regression.

## Change Record Template

Use this block in pull requests or development notes:

```markdown
### Upstream Review

- Baseline: `<upstream commit>`
- Issues/PRs reviewed: `#...`, or `No upstream analogue`
- Disposition: Implemented | Partial | Planned | Different by design | N/A platform
- Windows mapping: `<files and domain owner>`
- Regression coverage: `<tests or manual UI matrix>`
- Remaining gaps: `<explicit list or None>`
```

## Release Gate

A release is not parity-audited unless:

1. `npm run upstream:audit:check` passes.
2. Relevant new upstream fixes and features have dispositions.
3. Implemented fixes include appropriate Windows regression coverage.
4. Partial and planned items remain visible in this ledger.
5. Platform exclusions include an architectural reason.
