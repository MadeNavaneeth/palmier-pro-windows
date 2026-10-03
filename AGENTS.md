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

## Working Tree Safety

The working tree routinely holds hundreds of files of uncommitted work with no second copy, so
git is not a recovery mechanism in this repository.

- **Never run `git checkout`, `git restore`, `git stash`, `git clean`, or `git reset`** on any
  path. These are unrecoverable here. This has already caused two incidents: an agent reverted a
  native file holding roughly 1800 uncommitted lines, recoverable only from an out-of-band
  snapshot; and a `git stash push --include-untracked` round-tripped the entire tree through
  `core.autocrlf`, flipping line endings on about 200 files and breaking a `\r`-strict parser in
  three agent skill files.
- To inspect a baseline, use `git show HEAD:<path>` or `git diff`. Both are read-only.
- To undo your own edits, restore from a copy you made before you started. For a file you have not
  modified, no backup is needed.
- Copy a file to a temp directory before editing it when the change is risky or the file is large.
- Do not commit unless explicitly asked, and stage only the intended files.
- Line endings are pinned by `.gitattributes` (`* text=auto eol=lf`), so git stores LF and checks
  out LF. That is expected, not damage. Do not "fix" working-tree line endings, and do not read a
  line-ending difference as evidence that a `git stash` or `git checkout` round-trip occurred.
  Note that `.gitattributes` normalizes nothing retroactively — a file keeps its current bytes
  until git touches it — so a working-tree file may still be CRLF while the index and every
  future checkout are LF.

- **`git add` does not always normalize, and the exception is invisible.** It is true for 569 of the
  571 tracked files. The two that are not had been classified by git as *binary*, and a binary file
  skips the clean filter, so their CRLF was stored verbatim. Git 2.47 decides binary-ness from the
  whole file, not an 8000-byte window, and the trigger is any of: a NUL byte anywhere, or a single
  **lone CR** (a 0x0D not followed by 0x0A) anywhere. One lone CR is enough. When that happens git
  shows you a plausible whole-file text diff and emits **no** `CRLF will be replaced by LF`
  warning, because it believes the file is not text.

  Two real cases, both now fixed: `docs/UPSTREAM_ISSUES.md` accumulated 8 lone CRs from doubled-CR
  paragraph breaks, and `src/main/ipc/project.recent.test.ts` carried a raw NUL byte inside a
  template literal. **When writing a replacement string for `scripts/upstream-record-edit.mjs`,
  use bare `\n` and never a literal `\r\n`.** The guard expands `\n` to the file EOL on write, so a
  literal `\r\n` gets a second CR prefixed and becomes a doubled CR. That is how the 8 got there,
  and the old guard counted a lone CR as neither CRLF nor bare LF, so it certified the file as
  byte-safe. It now refuses with code `lone-cr` on the file as read, on the simulated plan text,
  and on the bytes re-read after the write.

  Check with `git ls-files --eol <path>`: `i/lf w/lf` is the healthy state, `i/-text` means git has
  classified the file as binary and is storing your bytes unchanged, and `w/mixed` means the
  working-tree file is inconsistent and will be rewritten on the next checkout. Measured on a
  throwaway clone: `text=auto` ALONE would NOT have prevented any of this, because it still routes
  through the binary check, and forcing a rewrite converted 156 files to CRLF including every
  pure-LF agent skill file. The `eol=lf` is what fixes the working-tree side.

- **Four agent `SKILL.md` files are pure LF, and `.gitattributes` now keeps them that way.** They were
  one `core.autocrlf=true` checkout away from the incident above, which is precisely why `eol=lf`
  was added rather than `text=auto` alone. No parser lives in those files, which are frontmatter
  and advisory prose; the one that reads them, `parseSkillFile` in `src/main/ai/skills.ts`, has
  split on `/\r?\n/` since `c39e560`, so CRLF would no longer drop a skill either way. Keep
  `parseSkillFile` tolerant of both endings regardless, and still never run a `git stash` here.

- **Never use PowerShell text cmdlets to read or write source files.** On Windows, PowerShell 5.1 decodes a BOM-less UTF-8 file using the ANSI code page and writes it back in that code page, so every non-ASCII character is mangled: an em dash (U+2014) becomes the three characters â€". A second round trip nests the damage (Ã¢â‚¬â€), and one of the bytes involved has no code-page mapping at all, so the original text is then unrecoverable. This silently corrupted comments in 23 source files. Use the read/write/edit tools, or Node with an explicit 'utf8' encoding. Reserve PowerShell for process work — running tests, git, builds — never for file content.

### Editing the upstream reconciliation record

`docs/UPSTREAM_ISSUES.md` keeps its whole history in one line of over 80,000 characters (line 1008). It has been silently corrupted twice in one session, by two mechanisms that both write cleanly and both parse cleanly: a `|` typed into prose invents a GFM table column without erroring, and a scripted `.replace()` whose anchor an earlier edit in the same run had already destroyed no-ops while a pre-edit anchor check still reported a match, which left a committed forward reference pointing at a record that was never written.

**Route every edit to that file through the guard.** Write the edit as a plan, keep the plan in a scratch directory rather than the repository, and run it:

```bash
node scripts/upstream-record-edit.mjs --plan <plan.json> [--dry-run]
```

```json
{
  "file": "docs/UPSTREAM_ISSUES.md",
  "edits": [
    {
      "id": "short-slug",
      "find": "literal text, unique when this edit runs",
      "replace": "literal replacement",
      "probe": { "text": "what must be there", "after": "the sentence that promised it" }
    }
  ]
}
```

It refuses to write, with a non-zero exit and nothing written, unless all of the following hold:

- Every anchor occurs **exactly once at the moment its own edit runs**, against the text as it stands after all earlier edits in the same run — not against the pre-edit text, which cannot see an earlier edit's side effect.
- After each edit, every later edit's anchor still occurs exactly once, so no edit can consume or duplicate one.
- No two anchors are equal or one a substring of the other, and no replacement contains another edit's anchor.
- Every declared `probe` is present **after** the sentence that promised it, so a forward reference cannot be written without the record it points at.
- The file's own invariants are unchanged: its U+FFFD count, its truncated double-encoding count, and its escaped-pipe-aware table shape. That last one is what catches a `|` in prose. The record already carries four over-wide rows (lines 114, 125, 132, 144) and three truncated runs on line 1008, and every count is taken relative to the pre-edit state — so an edit that invents a fifth column is refused, and so is one that quietly "repairs" the pre-existing corruption.

After writing, it re-reads the file and checks the same content invariants, the BOM, the line-ending style and the absence of bare LF, and that each anchor is gone while each replacement is present exactly once. If any of that fails it restores the exact pre-write bytes and exits non-zero. Exit 0 means a verified write, or a `--dry-run` that wrote nothing. It also refuses a file whose line endings are mixed, since no rewrite of it could be proven byte-preserving.

The structural checks it reuses are runnable on their own, and are what a hand edit to a ledger should be measured with:

```bash
node scripts/parity-table-check.mjs docs/UPSTREAM_ISSUES.md
node scripts/mojibake-check.mjs docs/UPSTREAM_ISSUES.md
```

`parity-table-check.mjs` splits cells the way GFM does, so an escaped `\|` is not read as a column boundary; a naive splitter reports phantom mismatches on these files. `mojibake-check.mjs` counts truncated double-encoding runs, which a U+FFFD scan misses because such a run still decodes greedily to something. The invariants above are regression-tested in `tests/upstream-record-edit.test.ts`, including a reconstruction of the consumed-period incident.

**The guard only covers edits made through it.** A hand edit is checked by none of the above, and the `edit` tool has rewritten whole files to LF in this repository; write this file with the guard, or with Node and an explicit `'utf8'`, and byte-audit whatever you touched.

## Coding Behavior Guidelines (Karpathy)

These principles apply to EVERY code change in this repository. They are
derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876)
on common LLM coding pitfalls.

### Think Before Coding

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- Every changed line should trace directly to the request.

### Goal-Driven Execution

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"

For multi-step tasks, state a brief plan with verification steps. Strong
success criteria let you loop independently.
