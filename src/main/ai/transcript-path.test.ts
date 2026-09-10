import { describe, expect, it } from 'vitest';
import path from 'path';
import { agentTranscriptPath } from './transcript-path';

describe('agent transcript path (L4c)', () => {
  it('puts one JSONL file per day under the app data directory', () => {
    const file = agentTranscriptPath('C:\\Users\\someone\\AppData\\Roaming\\Palmier', new Date('2026-09-11T23:59:00Z'));
    expect(file).toBe(path.join('C:\\Users\\someone\\AppData\\Roaming\\Palmier', 'agent-transcripts', 'agent-2026-09-11.jsonl'));
  });

  it('rotates by UTC day, deterministically for a given date', () => {
    const before = agentTranscriptPath('/data', new Date('2026-09-11T00:00:01Z'));
    const after = agentTranscriptPath('/data', new Date('2026-09-12T00:00:01Z'));
    expect(before).not.toBe(after);
    expect(before).toBe(agentTranscriptPath('/data', new Date('2026-09-11T23:00:00Z')));
  });
});
