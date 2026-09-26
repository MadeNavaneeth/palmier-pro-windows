# Prompt-injection review: subtitle-burn-in

Recorded alongside the skill per the L7 acceptance criteria. Skills are local
user files whose bodies are treated as untrusted text: audited before enable,
never auto-executed.

## What untrusted content this skill may contain

- Workflow prose and `transcribe_audio` / `import_srt` / `import_vtt` /
  `add_texts` / `set_title_text` / `verify_timeline` / `export_project`
  parameter advice (language hints, caption-planning controls, title styling).
- A `## Tools` section listing tool names. The anti-rot test pins every name
  against the live tool registry, so a renamed or invented tool fails the
  suite instead of reaching the model.
- Transcribed or imported subtitle text itself is third-party content: it may
  contain prompt-like instructions ("ignore previous directions"). Those words
  arrive as title-clip data and caption text, never as agent instructions, and
  this skill tells the model to style them, not to obey them.

## What it can do

- Advise the model to make ordinary, undoable tool calls that the user can see
  in the chat transcript and reverse with `undo`. Nothing here runs without an
  explicit tool call in a live turn.

## What it cannot do

- Invoke tools, mutate the timeline, or open undo entries by itself: the
  `load_skill` executor path returns the body as data and never interprets it
  (pinned by the advisory-only test).
- Spend transcription budget silently: `transcribe_audio` with an explicit
  engine refuses instead of falling back, and local transcription never sends
  audio anywhere. The skill repeats those rules; it cannot override them.
- Hide from the user: the skill index shows only its name and description, the
  body loads only via an explicit `load_skill` call, and disabling the skill
  removes it from both (pinned by test).

## Why enabling it is safe

- Every workflow step names a validated, existing tool; caption placement is
  undoable and `verify_timeline` checks the titles before export.
- No exfiltration, no external commands, no new capabilities beyond the tools
  the agent already exposes. The worst case is mistimed or misstyled captions,
  which the user sees in preview and reverses with `undo`.
