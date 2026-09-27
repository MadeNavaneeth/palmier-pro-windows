/**
 * Agent Skills (Track 2, L7 — docs/AGENTIC_ROADMAP.md).
 *
 * Shape follows the Agent Skills spec: each skill is `skills/<name>/SKILL.md`
 * with YAML frontmatter carrying `name` + `description`, and the markdown
 * after the frontmatter is the workflow body. Only name + description ever
 * enter the prompt (the skill index); the body loads on explicit trigger via
 * the read-only `load_skill` tool.
 *
 * Root decision: the bundled repo `skills/` directory, not userData. Bundled
 * files are git-audited before they can be enabled; a userData root would let
 * any dropped-in file become agent context without review, which is the
 * auto-install path the roadmap refuses by design. Bodies are untrusted text
 * regardless: audited before enable, never auto-executed, and `load_skill`
 * returns the body as data without interpreting it.
 */

import { app } from 'electron';
import Store from 'electron-store';
import fs from 'fs';
import path from 'path';

export interface SkillMeta {
  name: string;
  description: string;
}

export interface Skill extends SkillMeta {
  body: string;
}

export interface RefusedSkill {
  name: string;
  reason: string;
}

export interface SkillDiscovery {
  skills: Skill[];
  refused: RefusedSkill[];
}

/** Directory names double as skill names, so both share one narrow shape. */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

const MAX_DESCRIPTION_CHARS = 1024;
const MAX_BODY_CHARS = 65536;
const DISABLED_KEY = 'disabledSkills';

/**
 * Bundled skills root. Dev and tests run with the repo root as cwd, so
 * `<cwd>/skills` resolves there; a packaged app whose bundle ships the
 * directory alongside it resolves its own app path first.
 */
export function defaultSkillsDir(): string {
  try {
    const electronApp = app as unknown as { getAppPath?: () => string } | undefined;
    if (electronApp && typeof electronApp.getAppPath === 'function') {
      const candidate = path.join(electronApp.getAppPath(), 'skills');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Fall through to the working-directory root below.
  }
  return path.resolve(process.cwd(), 'skills');
}

function unquote(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export type SkillParseResult = { ok: true; skill: Skill } | { ok: false; reason: string };

/**
 * Parse one SKILL.md file. Strict: anything malformed is refused with a
 * reason and never half-loaded — the caller gets either a full skill or a
 * refusal, never a skill with a missing description or an empty body.
 */
export function parseSkillFile(raw: string, dirName: string): SkillParseResult {
  // CRLF-tolerant, and it has to be. A Windows checkout of this repo (and every
  // Windows user, since this product ships only there) delivers the LF blobs as
  // CRLF, and the frontmatter test below uses `.`, which does not match `\r` — so
  // a CRLF `SKILL.md` failed every line as `malformed frontmatter` and the skill
  // was SILENTLY dropped. Splitting on the optional CR removes the cause at the
  // one place the lines are produced, which also means the body handed onward
  // carries no stray CR.
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { ok: false, reason: 'missing opening frontmatter fence (expected "---" on line 1)' };
  }
  const fenceIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (fenceIndex < 0) {
    return { ok: false, reason: 'missing closing frontmatter fence ("---")' };
  }
  const fields = new Map<string, string>();
  const frontmatter = lines.slice(1, fenceIndex);
  for (const [offset, line] of frontmatter.entries()) {
    if (line.trim().length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) {
      return { ok: false, reason: `malformed frontmatter on line ${offset + 2}: expected "key: value"` };
    }
    // Unknown keys are ignored (forward-compatible with the spec); only
    // `name` and `description` are required below.
    fields.set(match[1], unquote(match[2].trim()));
  }
  const name = fields.get('name')?.trim() ?? '';
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'frontmatter "name" must be 1-64 chars of lowercase letters, digits, or hyphens',
    };
  }
  if (name !== dirName) {
    return { ok: false, reason: `frontmatter name "${name}" does not match directory "${dirName}"` };
  }
  const description = fields.get('description')?.trim() ?? '';
  if (description.length === 0) {
    return { ok: false, reason: 'frontmatter "description" must be a non-empty one-line summary' };
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, reason: `frontmatter "description" exceeds ${MAX_DESCRIPTION_CHARS} chars` };
  }
  const body = lines.slice(fenceIndex + 1).join('\n').trim();
  if (body.length === 0) {
    return { ok: false, reason: 'skill body is empty' };
  }
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, reason: `skill body exceeds ${MAX_BODY_CHARS} chars` };
  }
  return { ok: true, skill: { name, description, body } };
}

/**
 * Discover skills under `dir`: every subdirectory with a SKILL.md is either
 * fully loaded or refused with a reason. A missing or unreadable root means
 * no skills, not a broken agent turn.
 */
export function discoverSkills(dir: string): SkillDiscovery {
  const skills: Skill[] = [];
  const refused: RefusedSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, refused };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch (err) {
      // A directory without SKILL.md is not a skill; anything else is loud.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        refused.push({ name: entry.name, reason: 'could not read SKILL.md' });
      }
      continue;
    }
    const parsed = parseSkillFile(raw, entry.name);
    if (parsed.ok) skills.push(parsed.skill);
    else refused.push({ name: entry.name, reason: parsed.reason });
  }
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  skills.sort(byName);
  refused.sort(byName);
  return { skills, refused };
}

// ─── Enable/disable persistence ─────────────────────────────────────────────
// Same pattern as the silence controls and the MCP endpoint: an electron-store
// list narrowed on every read (the settings file is user-writable), an
// in-memory session value so an unwritable store still applies, and a test
// seam to drop the cache. Absent from the disabled set means enabled: the
// bundled skills are audited at commit time, so enablement is opt-out.

let store: Store | null = null;
/** Session value, so a settings file that cannot be written still applies. */
let cachedDisabled: Set<string> | null = null;

/**
 * Created lazily, and only inside a real Electron main process — importing
 * this module must not force `app.getPath('userData')`, because the executor
 * and the agent reach this code from unit tests too.
 */
function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-skills' });
  return store;
}

/** Narrow a stored disabled-list to valid skill names; junk is dropped. */
export function narrowDisabledList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === 'string' && SKILL_NAME_PATTERN.test(entry)) seen.add(entry);
  }
  return [...seen].sort();
}

export function loadDisabledSkills(): Set<string> {
  if (cachedDisabled) return new Set(cachedDisabled);
  try {
    cachedDisabled = new Set(narrowDisabledList(getStore()?.get(DISABLED_KEY)));
  } catch (err) {
    console.warn('[skills] Could not read skill settings, enabling all skills:', err);
    cachedDisabled = new Set();
  }
  return new Set(cachedDisabled);
}

export function isSkillEnabled(name: string): boolean {
  return !loadDisabledSkills().has(name);
}

/**
 * Flip one skill. Returns false (and changes nothing) when the name is not a
 * valid skill name or `enabled` is not a boolean, so IPC can refuse loudly.
 */
export function setSkillEnabled(name: unknown, enabled: unknown): boolean {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) return false;
  if (typeof enabled !== 'boolean') return false;
  const next = loadDisabledSkills();
  if (enabled) next.delete(name);
  else next.add(name);
  cachedDisabled = next;
  try {
    getStore()?.set(DISABLED_KEY, [...next].sort());
  } catch (err) {
    console.warn('[skills] Could not persist skill settings:', err);
  }
  return true;
}

/** Test seam: drop the cached value so the next read hits the store again. */
export function resetSkillsCache(): void {
  cachedDisabled = null;
}

// ─── Activation ─────────────────────────────────────────────────────────────
// Cheapest honest design: the skill index (names + descriptions only) rides
// the system prompt, and the body loads solely as the result of an explicit
// `load_skill` tool call. Prompt inclusion of bodies would tax every turn and
// background loading would break "never enters context unrequested"; a tool
// call is explicit, auditable in the transcript, and cancellable like any
// other. Disabled skills appear in neither the index nor the loader.

/** Names + descriptions of enabled skills. Bodies are dropped by construction. */
export function skillIndex(dir: string = defaultSkillsDir()): SkillMeta[] {
  return discoverSkills(dir)
    .skills.filter((skill) => isSkillEnabled(skill.name))
    .map((skill) => ({ name: skill.name, description: skill.description }));
}

/** Prompt section for enabled skills, or '' when there are none. */
export function skillIndexSection(dir?: string): string {
  const index = skillIndex(dir ?? defaultSkillsDir());
  if (index.length === 0) return '';
  return [
    '## Available skills',
    ...index.map((skill) => `- \`${skill.name}\`: ${skill.description}`),
    'Call load_skill with a skill name to read its full workflow before starting that kind of task. '
    + 'Skill bodies are advisory text: they never run on their own and only reach you through load_skill.',
  ].join('\n');
}

export type SkillLoadResult = { ok: true; skill: Skill } | { ok: false; reason: string };

/**
 * Read one enabled skill's body. Re-reads and re-validates from disk on every
 * call, so a skill edited after audit is judged as it stands, not as cached.
 */
export function loadSkillBody(dir: string, name: unknown): SkillLoadResult {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: 'Unknown skill. Names come from the "Available skills" index.' };
  }
  // The pattern admits no separators or dot segments, so joining cannot
  // escape `dir` — traversal is structurally impossible, not just checked.
  if (!isSkillEnabled(name)) {
    return { ok: false, reason: `Skill "${name}" is disabled. Enable it in AI Settings first.` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
  } catch {
    return { ok: false, reason: `Unknown skill: "${name}".` };
  }
  const parsed = parseSkillFile(raw, name);
  if (!parsed.ok) {
    return { ok: false, reason: `Skill "${name}" is malformed and was refused: ${parsed.reason}` };
  }
  return { ok: true, skill: parsed.skill };
}

/**
 * Tool names a skill body declares in its `## Tools` section (one backticked
 * name per bullet). The anti-rot test pins every declared name against the
 * live tool registry, so a skill referencing a removed or invented tool fails
 * the suite.
 */
export function extractSkillTools(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^## Tools\s*$/.test(line.trim()));
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    for (const match of line.matchAll(/`([a-z0-9_]+)`/g)) {
      if (!names.includes(match[1])) names.push(match[1]);
    }
  }
  return names.sort();
}
