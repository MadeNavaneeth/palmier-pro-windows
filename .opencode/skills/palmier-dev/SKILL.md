# Palmier Pro Windows — Development Skill

TRIGGER when working on code in this repository (palmier-pro-windows).

You are working on **Palmier Pro Windows** — a Windows Electron + React + TypeScript
video editor ported from the macOS upstream [palmier-io/palmier-pro]. It uses a Rust/wgpu
native addon for GPU compositing and FFmpeg for decode/export.

---

## Project Location

The canonical working copy is at `D:\Projects\palmier-pro-windows`.
Upstream clone: `D:\Projects\palmier-pro-upstream` (used for reading upstream Swift source).

## Architecture (memorize this)

```
src/
  shared/           ← Pure TypeScript shared by renderer + main (NO electron imports)
    types/project.ts    ← Clip, Track, TimelineMarker, MediaAsset models
    editor/controller.ts← EditorController: ALL mutations go through here
    editor/commands.ts  ← Command classes (undoable, serializable)
    editor/markers.ts   ← Timeline marker model + ripple mapping
    media/source-time.ts← THE source-time mapping (#68) — preview+export MUST use this
    media/export-eligibility.ts ← Export clip selection (muted audio excluded)
    audio/              ← Silence detector, waveform bucketing, pan, normalize
  main/             ← Electron main process (Node.js, can use child_process, fs)
    media/              ← FFmpeg wrappers, frame decoder, compositor, proxies
    ai/                 ← Agent tool definitions + executor + MCP server
    ipc/                ← IPC handlers bridging renderer ↔ main
  renderer/          ← React UI (sandboxed, no Node access; goes through preload)
    components/timeline/ ← TimelineClip, TrackHeader, TimelineRuler
    engine/              ← PlaybackEngine (rAF loop), preview-engine (canvas), audio-preview
    store/timeline.ts    ← Zustand store wrapping EditorController
    lib/                 ← Pure helpers (clip-hit-testing, waveform-cache, filmstrip-cache)
  preload/index.ts   ← contextBridge exposing window.palmier API (the ONLY bridge)
```

## Core Rules

1. **ALL mutations go through `EditorController` commands.** UI, agent, and MCP share the same validated undoable operations.
2. **Preview and export MUST agree.** Both consume `selectExportClips()` and both map source time through `source-time.ts`. If you change one, change both.
3. **New model fields must be optional** so old projects decode without migration. Only add migrations for BREAKING changes in `shared/editor/migrations.ts`.
4. **Never import electron in `shared/` files** — they must work in vitest without Electron.
5. **Agent/MCP tools are defined in `main/ai/tools.ts`** (Zod schemas) and dispatched in `main/ai/executor.ts`.

## Gates (run before every push)

```
npm run typecheck
npm run lint        # 0 errors required; ~60 warnings are pre-existing
npm test            # all tests must pass (~800 tests across 90+ files)
npm run ui:probe    # rendered layout check at 1600×1000 + 1024×680
```

Or chain them: `powershell -File scripts/run-gates.ps1`

## Upstream Sync Workflow

Before starting any feature: `npm run upstream:audit`
If stale: `npm run upstream:audit:write`, then read the new commits from
`D:\Projects\palmier-pro-upstream` (git fetch origin && git log).
Record dispositions in `docs/UPSTREAM_PARITY.md`.

## Common Patterns

### Adding a new controller operation
```ts
// In src/shared/editor/controller.ts:
myOperation(args): Result | null {
  // validate → throw Error with user-facing message on refusal
  // build replacement arrays immutably (no in-place mutation)
  // this.execute(new SomeCommand(...)) → ONE undoable step
  // return receipt object or null for no-op
}
```

### Adding an agent tool
```ts
// 1. Schema in src/main/ai/tools.ts (Zod object with .describe() on each field)
// 2. Case in src/main/ai/executor.ts dispatch switch
// 3. Try/catch domain errors → { success: false, error: message }
```

### Adding clip fields
- Add to `Clip` interface in `shared/types/project.ts` as OPTIONAL
- Set defaults in `createPlacedClip()` if needed
- Include in `transferClipSettings` field list if it's a visual setting
- Update `settingsDiffer` comparator if it affects paste-attributes detection
- If it affects rendering: update BOTH `preview-engine.ts` AND `export-args.ts`

### Testing pattern
```ts
// Controller tests: create controller, addMedia, addClip, exercise op, assert state + undo
// Export-args tests: projectWithMedia() fixture, call buildFfmpegArgs(), assert arg strings
// Executor tests: wrap controller in ToolExecutor, call execute(toolName, args)
```

## Known Pitfalls

- **PowerShell encoding**: NEVER pipe file content through PowerShell `Set-Content`/`Get-Content` for files with non-ASCII chars — it double-encodes UTF-8. Use Node scripts or the Write/Edit tools instead.
- **Test flakiness**: The first full-suite run after editing files sometimes has 1 random failure (transform cache race). Re-run to confirm; three consecutive greens = stable.
- **Module-singleton store**: `useTimelineStore` is a module singleton. Tests that share it must clean up state between cases.
- **addClip auto-links**: Video assets with `audioCodec` set automatically create a linked audio partner on placement. Don't assume clips are independent.
- **`npm ci` lockfile**: After changing dependencies locally, ALWAYS run `npm install --package-lock-only` and commit the updated lockfile before pushing, or CI's `npm ci` will fail.

## Agent Tool Surface (current)

| Tool | Purpose |
|---|---|
| get_timeline / get_clips / get_media | Read operations |
| add_clip (mode: overwrite/insert/append) | Place media |
| add_texts / set_title_text | Title management |
| remove_clip / trim_clip / split_clip / move_clip | Basic edits |
| ripple_delete_clips / gap / ranges | Ripple edits |
| ripple_trim_clip | Ripple trim |
| manage_tracks | Create/rename/reorder/remove tracks |
| manage_clip_links | Link/unlink clips |
| swap_clip_media | Replace clip source keeping edit state |
| copy_clip_settings | Paste attributes |
| set_clip_speed | Constant speed 0.25–4x |
| normalize_audio | Peak normalization via volumedetect |
| manage_markers | Timeline markers CRUD |
| set_project_settings | fps/resolution changes |
| undo / redo | History |

## Key File Paths

| What | Where |
|---|---|
| Editor controller (all mutations) | `src/shared/editor/controller.ts` |
| Agent tool schemas | `src/main/ai/tools.ts` |
| Agent executor dispatch | `src/main/ai/executor.ts` |
| Export argument builder | `src/main/media/export-args.ts` |
| Preview compositor (GPU) | `src/main/media/preview-compositor.ts` |
| Render cache | `src/main/media/render-cache.ts` |
| Clip model | `src/shared/types/project.ts` |
| Source-time mapping | `src/shared/media/source-time.ts` |
| Parity ledger | `docs/UPSTREAM_PARITY.md` |
| Roadmap | `docs/PRODUCT_ROADMAP.md` |
