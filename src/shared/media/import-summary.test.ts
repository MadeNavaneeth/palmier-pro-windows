import { describe, it, expect } from 'vitest';
import { formatImportErrors } from './import-summary';

describe('formatImportErrors', () => {
  it('returns empty for no skips', () => {
    expect(formatImportErrors(undefined)).toBe('');
    expect(formatImportErrors([])).toBe('');
  });

  it('lists every reason when there are only a few', () => {
    expect(formatImportErrors(['a.txt is not a supported media file'])).toBe(
      'a.txt is not a supported media file',
    );
    expect(formatImportErrors(['a.txt is not a supported media file', 'Could not read folder b'])).toBe(
      'a.txt is not a supported media file · Could not read folder b',
    );
  });

  it('counts the remainder instead of hiding it', () => {
    const summary = formatImportErrors([
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
    ]);
    expect(summary).toBe('one · two · three (+4 more)');
  });
});
