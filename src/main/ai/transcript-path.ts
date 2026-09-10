/**
 * Transcript file location (Track 2, L4c — docs/AGENTIC_ROADMAP.md).
 *
 * Split out of the IPC module so the path rule is testable without importing
 * Electron. Rotation is by day rather than by size: it needs no state, cannot
 * surprise a user mid-session, and keeps one session's audit trail in one file.
 */

import path from 'path';

/** One JSONL file per day under `<userData>/agent-transcripts`. */
export function agentTranscriptPath(userDataDir: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return path.join(userDataDir, 'agent-transcripts', `agent-${day}.jsonl`);
}
