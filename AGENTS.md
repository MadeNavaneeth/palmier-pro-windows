# Palmier Pro Windows Agent Guide

This repository is the Windows implementation of
[palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro). The
upstream macOS repository is the product and behavior reference. Platform code
must be translated into this Electron, React, TypeScript, Rust/wgpu, and FFmpeg
architecture rather than copied mechanically.

## Mandatory Upstream Check

Before any nontrivial bug fix, feature, UI change, refactor, or release:

1. Run `npm run upstream:audit`.
2. If the snapshot is stale, run `npm run upstream:audit:write`.
3. Read `docs/UPSTREAM_PARITY.md` and `docs/UPSTREAM_SNAPSHOT.md`.
4. Search upstream code, issues, merged pull requests, and tests for the owning
   feature. Check both open issues and fixes merged after the recorded baseline.
5. Record the relevant upstream issue, PR, commit, or an explicit "no upstream
   analogue" in the change notes or pull request.
6. Update `docs/UPSTREAM_PARITY.md` when the Windows disposition changes.

Do not claim parity from matching UI alone. Trace behavior through state
ownership, validation, undo, persistence, preview, export, Agent/MCP surfaces,
failure handling, cancellation, and tests.

## Upstream Dispositions

Every reviewed upstream item must receive one disposition:

- `Implemented`: equivalent behavior and regression coverage exist on Windows.
- `Partial`: some behavior exists; missing parts are listed explicitly.
- `Planned`: relevant and not implemented yet.
- `Different by design`: Windows uses a documented alternative contract.
- `N/A platform`: the issue depends on Apple-only frameworks or packaging and
  cannot occur in this stack.
- `Needs investigation`: relevance or Windows exposure is not yet established.

`N/A platform` and `Different by design` require a concrete architectural
reason. They are not shortcuts for skipping work.

## Translation Rules

- Preserve user-visible behavior and invariants, not Swift/AppKit file layout.
- Keep one authoritative mutable project owner in the editor controller.
- Route UI and Agent edits through the same undoable domain operations.
- Validate IPC, Agent, filesystem, frame, duration, and numeric inputs.
- Keep blocking file and media work out of the renderer interaction path.
- Preview and export must share timing, geometry, compositing, and eligibility
  rules where practical.
- One user action should be one coherent undo operation.
- Every adopted upstream bug fix needs a Windows regression test when practical.
- UI changes require rendered checks at 1600x1000 and 1024x680.

## Required Finish Checks

Run the relevant focused tests while iterating, then:

```bash
npm run upstream:audit:check
npm run typecheck
npm run lint
npm test
```

For native changes also run:

```bash
cd native
cargo check
cargo test
```

Update the parity ledger and snapshot before a release.
