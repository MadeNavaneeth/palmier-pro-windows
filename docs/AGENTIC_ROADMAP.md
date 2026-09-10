# Agentic Roadmap

Two tracks, one goal: reach the frozen upstream macOS feature level, then go
further with research-backed agentic layers that make this port better in an
agent-first world without changing the editor's core contract.

Track 1 is parity. Track 2 is ours. Track 1 items follow
[`UPSTREAM_PARITY.md`](./UPSTREAM_PARITY.md); this file sequences Track 2 and
records the acceptance criteria for both.

## Ground rules

- The editor core (project model, `EditorController`, undo, IPC, export) is
  the authority. Agentic layers only *use* it through the existing validated
  tool surface — no second mutation path.
- Every layer ships with objective tests before it ships at all. An eval
  scenario that does not flip from failing to passing is not a feature.
- One user action remains one undo step; no layer may split an edit across
  undo entries or serialize the whole timeline into context by default.
- Prefer just-in-time reads of the authoritative project over cached
  summaries; caches are regenerated, never hand-edited.

## Track 1 — Parity to the frozen baseline

Baseline: upstream `8805801f` (2026-08-24), snapshot `b4b1333` (appcast only).
Remaining work is the closed backlog in the ledger, not future commits.

| Phase | Items | Exit criterion |
|---|---|---|
| P1 — close Partial rows | #154 effects/blend in FCPXML, #157 shot settings, #286 panel tabs/detach, #532 protocol revision, #118 AI descriptions, #20 linux artifacts, #39 local STT | Every Partial row either moves to Implemented with coverage or names its blocker in one line |
| P2 — big Planned items | #45 shape annotations, #50 variable fonts, #59 HDR export, #137 multi-session, #142 Codex CLI provider, #155 compound clips, #156 library hierarchy, #165 noise reduction, #430 adaptive light theme | Each item has a domain owner, tests, and a rendered/exported check where applicable |

Sequence: P1 before P2 except when a P2 item is a prerequisite (#155 gates
#154's nested-sequence note; #59 needs the compositor color contract first).

## Track 2 — Our agentic layers

Each layer names its mechanism, the research it comes from, and the files it
owns. Research digest: frontier harness mechanisms (SWE-agent ACI, Codex plan
and compaction, OpenHands condenser, OpenAI Agents SDK, Anthropic context
engineering / multi-agent research / Agent Skills, Self-Refine, Reflexion).

### L1 — Editing eval harness (this commit)

Mechanism: scenario evals with objective assertions run through the *real*
`ToolExecutor` (SWE-bench FAIL_TO_PASS practice). No model, no network.
Contract: `src/main/ai/evals/editing.test.ts`, `npm run evals`.

Acceptance:
- ≥6 scenarios covering trim/ripple, marker deltas, grade/EQ/compressor
  pipelines, project round-trip, refusal integrity, layout geometry.
- Assertions read domain state after the run, never tool receipts alone.
- One scenario pins undo discipline: each call is exactly one undo entry.

### L2 — Verification tool (shipped)

Mechanism: evaluator-optimizer / Self-Refine. A read-only `verify_timeline`
tool returns structured diagnostics (overlaps, zero-length clips, clips past
source end, offline media, orphaned linked partners, fades longer than the
clip, empty titles, invalid markers) so the model can check its own work
instead of asking the user to spot mistakes.

Shipped: `shared/editor/diagnostics.ts` (pure, unit-tested — every code has a
seeded-defect test and a clean project returns none), `verify_timeline` in
`main/ai/tools.ts` + `executor.ts` (the executor supplies the one fact the
pure audit cannot know: whether each library file is still on disk), and an
agent-prompt rule to run it after destructive batches. `executor.verify.test.ts`
pins that the tool is read-only: no project change, no undo entry.

### L3 — Plan tool (shipped)

Mechanism: Codex `update_plan` / Claude Code todo pattern. Stateless
`update_plan` tool replaces the structured plan (≤ one `in_progress`),
surfaced in the chat panel. Plan state is UI-only and never enters the project
model.

Shipped: `shared/editor/plan.ts` (pure `normalizePlan` / `planSummary`,
unit-tested — trimming, caps, one-active-step enforcement), `update_plan` in
`main/ai/tools.ts` + `executor.ts` via an `onPlanUpdate` dep, `ai:plan` over
IPC, session `plan` state in `renderer/store/ai.ts` (cleared with the
transcript, narrowed again on receipt), and the `PlanChecklist` in
`ChatPanel.tsx` (height-capped internal scroll so 12 steps cannot push the
composer off screen; shape-differentiated statuses). `executor.plan.test.ts`
pins that the tool never mutates the project or opens an undo entry.

Not yet covered: a model-backed eval that drives a real turn and asserts the
final plan matches the calls actually made — that needs the trajectory-replay
harness from L1's next revision, not the model-free scenarios we have today.

### L4 — Context discipline

Mechanism: cheapest-first compaction (Anthropic; SWE-agent `LastNObservations`;
OpenHands condenser defaults). Order: (1) elide old tool outputs with
placeholders and keep tags for `keep_output` results, (2) inject a project
digest regenerated from the controller on each turn, (3) LLM summarization at
~90% of the provider window with pinned user messages + plan + digest,
(4) hard reset as last resort. Raw transcript stays on disk.

Shipped so far — step (2), the derived digest: `shared/editor/project-digest.ts`
is pure and regenerated on every turn (name/canvas/fps, content length, track
and per-type clip counts, library size, marker statuses, and a structural-audit
line that points at `verify_timeline` when anything is wrong). It rides the
system prompt for both provider paths, and `agent.digest.test.ts` pins that it
reaches the outgoing request *and* is re-derived between two turns rather than
cached. Unit tests cover empty, populated, and defective projects.

Shipped step (1), tool-result elision: `shared/editor/tool-output-policy.ts` is
pure and rewrites only the *content* of older `tool_result` blocks in the
outgoing Anthropic request, keeping the last `TOOL_RESULT_KEEP_LAST` (6) verbatim
and replacing earlier ones with a placeholder. Message count, order, and
`tool_use_id`s are untouched by construction, so the API's history invariants
survive — `expectWellFormed` in `agent.anthropic.test.ts` still passes on the
elided payload, which is the real guarantee here. Two deliberate exceptions:
error results are never elided (short, and a model that forgets its own failed
calls repeats them), and an already-elided result is never re-wrapped (idempotent,
verified by identity). The stored history keeps full fidelity; only the request
is elided, which is also why the OpenAI path needs nothing — `openAiHistory()`
already replays text only.

Shipped steps (3) and (4), budget + summarization + hard reset, with the raw
transcript on disk. `shared/ai/context-budget.ts` is pure: a deliberate
four-characters-per-token estimate (a 90% threshold does not need a tokenizer in
the main process), conservative per-provider windows (200k Anthropic, 128k for
the heterogeneous OpenAI-compatible set) with a validated `contextWindow`
override, the 90% threshold, and the transcript rendering that bounds the
summarizer's input twice — per tool result, because one `get_timeline` dump can
dwarf the conversation, and in total by dropping the middle with an explicit
marker, keeping the head (what the user asked for) and the tail (where the work
stands).

`compactIfNeeded` runs **once per turn, before the request is built, never
mid-round**: a summary landing between an assistant turn and its tool results
would leave a tool call unanswered, which both providers reject. Order of
resort is summarize → if the summary still does not fit, drop the past entirely,
keeping only the freshly derived system prompt and the user's new message. A
summarization failure degrades to the same reset rather than failing the turn,
because losing the backlog is bad but refusing to answer is worse. The
measurement itself is exposed as `estimatedRequestTokens` so the tests threshold
on the same number the agent does rather than an approximation that could
disagree with the decision.

The raw transcript is always on in the app: JSON Lines, one file per UTC day
under `<userData>/agent-transcripts`, recording each user turn, assistant
completion, tool result and compaction event (`compaction-start`, `compacted`,
`reset` with the reason) so what a summary dropped stays auditable. Appends are
tiny, happen at turn boundaries, and an unwritable path is swallowed — auditing
must never break a turn.

L4 is complete. Remaining in the layer at large: nothing; L6/L7 are separate.

### L5 — Read-only parallelism

Mechanism: OpenAI Agents SDK concurrency cap + Anthropic multi-agent findings.
Run independent *read-only* tools concurrently (bounded), keep mutations
serialized through the controller so undo grouping stays deterministic.

Acceptance:
- Tool registry marks each tool `readonly | mutating`; a test asserts the
  classification covers all tools and that mutating batches never run
  concurrently.
- Receipts preserve model-order; a failure in one readonly call does not
  cancel its siblings.

Shipped. The classification is a side table (`READ_ONLY_TOOLS` /
`isReadOnlyTool` in `tools.ts`) rather than a schema field: the model must not
see it, and absence means mutating, so a newly added tool is serialized until a
human lists it — the safe direction. Read-only today: `get_timeline`,
`get_clips`, `get_media`, `verify_timeline`, `inspect_frame`. The agent loop
(`runToolBatch` in `agent.ts`) executes maximal runs of consecutive read-only
calls concurrently, bounded by `READ_ONLY_TOOL_CONCURRENCY` (4), with a mutating
call acting as a barrier awaited alone — so a call that follows an edit still
observes that edit, which is the property that makes this safe rather than
merely fast. Both provider loops share the one runner, and results are placed
back in call order whatever order they completed in, which is what both APIs
require. Cancellation stops starting new calls; Anthropic still answers every
`tool_use` (the invariant that keeps a conversation usable after a stop), and
the OpenAI path discards its local batch as before.

Tests: `agent.parallel-tools.test.ts` proves overlap with a barrier that only
releases once all three calls have *started* — a serial loop would deadlock on
it, so the test is a structural proof rather than a timing observation — plus
reverse-completion ordering, the mutation barrier, and that the read-only set
names only real tools while unknown names default to mutating.

### L6 — Investigator subagents (deliberate, last)

Mechanism: orchestrator-worker with schema-validated summaries. One
`spawn_investigator` tool exposing only read-only tools for audits ("find
every silent segment", "list clips over 20 s"), returning a bounded digest.
Not for edit sequences — Anthropic's own research notes coding tasks
parallelize poorly and cost ~15× tokens.

Acceptance:
- Fan-out cap (3), token budget per worker, and disk-backed artifacts.
- A kill-switch setting; the feature is off by default until evals show a
  win over the single-agent baseline.

### L7 — Skills (reusable editor expertise)

Mechanism: Agent Skills spec (name + description loaded; body on trigger).
Ship `skills/<name>/SKILL.md` for recurring workflows (podcast cleanup,
shorts reframe, subtitle burn-in) with FFmpeg recipes in `scripts/`.
Skills are local files, audited before enable, and A/B'd against a no-skill
baseline; a skill that does not beat baseline is deleted.

Acceptance:
- Loader + activation test; user-facing enable/disable list.
- Prompt-injection review recorded per skill (skills are user files).

## What we deliberately do not adopt

- Framework abstraction layers that hide prompts/tool schemas; the loop stays
  in this repo ([building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
- Decentralized multi-agent handoffs for a single-editor app; one agent in
  control, workers only as bounded read-only tools.
- Code-diff edit formats (udiff/search-replace) — our tool surface already
  emits structured domain commands.
- Unbounded reflection loops; caps at 2–3 iterations with evidence required.
- Auto-installing skills or MCP servers from untrusted sources.
