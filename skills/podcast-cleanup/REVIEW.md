# Prompt-injection review: podcast-cleanup

Recorded alongside the skill per the L7 acceptance criteria. Skills are local
user files whose bodies are treated as untrusted text: audited before enable,
never auto-executed.

## What untrusted content this skill may contain

- Workflow prose and `remove_silence` / `normalize_audio` / `set_clip_eq` /
  `set_clip_compressor` / `verify_timeline` / `export_project` parameter advice
  (thresholds, dB targets, band ranges).
- A `## Tools` section listing tool names. The anti-rot test pins every name
  against the live tool registry, so a renamed or invented tool fails the
  suite instead of reaching the model.

## What it can do

- Advise the model to make ordinary, undoable tool calls that the user can see
  in the chat transcript and reverse with `undo`. Nothing here runs without an
  explicit tool call in a live turn.

## What it cannot do

- Invoke tools, mutate the timeline, or open undo entries by itself: the
  `load_skill` executor path returns the body as data and never interprets it
  (pinned by the advisory-only test).
- Reach the filesystem, network, export presets, or settings outside the
  parameters of the listed tools.
- Hide from the user: the skill index shows only its name and description, the
  body loads only via an explicit `load_skill` call, and disabling the skill
  removes it from both (pinned by test).

## Why enabling it is safe

- Every workflow step names a validated, existing tool; destructive steps end
  with `verify_timeline` before the turn reports success.
- No exfiltration, no external commands, no new capabilities beyond the tools
  the agent already exposes. The worst case is a wasted or refused tool call,
  which the executor reports as an error the model must explain.
