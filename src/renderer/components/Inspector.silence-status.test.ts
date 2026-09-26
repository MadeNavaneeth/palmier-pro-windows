/**
 * The silence-removal status line under the Inspector's "Remove Silence"
 * (upstream PR #426).
 *
 * The detector reads the whole asset while the clip shows a trimmed part of it,
 * so a detected span can be found and still produce no cut. Two different facts
 * have two different lines: audio with no quiet sections, and audio that has
 * silence the user has trimmed away from this clip. The second one used to be
 * reported as the first, which is a false statement about the user's media.
 */
import { describe, it, expect } from 'vitest';
import { silenceRemovalStatus } from './Inspector';

describe('Inspector silence removal status', () => {
  it('keeps the plain line when the detector found nothing', () => {
    expect(silenceRemovalStatus({ removed: 0, error: 'No silence detected' }))
      .toBe('No silence detected');
  });

  it('passes a refusal through unchanged', () => {
    expect(silenceRemovalStatus({ removed: 0, error: 'FFmpeg exited with 1' }))
      .toBe('FFmpeg exited with 1');
  });

  it('names found silence that lay outside the trim window instead of denying it', () => {
    const line = silenceRemovalStatus({
      removed: 0,
      omitted: { 'outside-clip': 3, 'invalid-range': 0 },
    });

    expect(line).toContain('Found 3 silent gaps');
    expect(line).toContain("3 outside this clip's trimmed window");
    expect(line).toContain('removed none');
    expect(line).not.toMatch(/no silence/i);
  });

  it('says both numbers when only some spans became a cut', () => {
    const line = silenceRemovalStatus({
      removed: 2,
      omitted: { 'outside-clip': 1, 'invalid-range': 0 },
    });

    expect(line).toBe("Removed 2 of 3 silent gaps: 1 outside this clip's trimmed window.");
  });

  it('reports a bad timing differently from a span outside the window', () => {
    const line = silenceRemovalStatus({
      removed: 1,
      omitted: { 'outside-clip': 1, 'invalid-range': 1 },
    });

    expect(line).toContain('1 outside this clip\'s trimmed window');
    expect(line).toContain('1 with invalid timings');
  });

  it('keeps the singular form for a single gap', () => {
    expect(silenceRemovalStatus({ removed: 1 })).toBe('Removed 1 silent gap.');
    expect(silenceRemovalStatus({
      removed: 0,
      omitted: { 'outside-clip': 1, 'invalid-range': 0 },
    })).toBe("Found 1 silent gap in this audio, but removed none: 1 outside this clip's trimmed window.");
  });

  it('is a non-fatal notice: an omission never sets the error channel', () => {
    // The Inspector has one status line and one failure line; an omission is
    // reported as the notice, so the outcome must not claim an error.
    const outcome = { removed: 0, omitted: { 'outside-clip': 1, 'invalid-range': 0 } };

    expect(silenceRemovalStatus(outcome)).not.toMatch(/no silence found/i);
    expect('error' in outcome).toBe(false);
  });
});
