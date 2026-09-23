import { describe, expect, test } from 'vitest';
import { neonSafeBranchName } from './branch_name.js';

describe('neonSafeBranchName', () => {
  test('lowercases and slugifies a simple name', () => {
    expect(neonSafeBranchName('Feature')).toBe('feature');
  });

  test('preserves slashes as segment separators', () => {
    expect(neonSafeBranchName('feature/billing-ui')).toBe(
      'feature/billing-ui',
    );
  });

  test('sanitizes each segment and collapses separator runs', () => {
    expect(neonSafeBranchName('feature/PROJ-123 Add  Billing!!')).toBe(
      'feature/proj-123-add-billing',
    );
  });

  test('trims leading/trailing separators per segment', () => {
    expect(neonSafeBranchName('--feature--/__billing__')).toBe(
      'feature/billing',
    );
  });

  test('drops empty segments from repeated slashes', () => {
    expect(neonSafeBranchName('feature///billing')).toBe('feature/billing');
  });

  test("falls back to 'branch' for an empty/punctuation-only input", () => {
    expect(neonSafeBranchName('')).toBe('branch');
    expect(neonSafeBranchName('///')).toBe('branch');
    expect(neonSafeBranchName('!!!')).toBe('branch');
  });

  test('clamps to 256 characters and strips a dangling separator', () => {
    const result = neonSafeBranchName(`${'a'.repeat(260)}-bbbbb`);
    expect(result.length).toBeLessThanOrEqual(256);
    expect(result.endsWith('-')).toBe(false);
    expect(result.endsWith('/')).toBe(false);
  });

  test('is idempotent on an already-valid name', () => {
    const once = neonSafeBranchName('preview/feature/billing-ui');
    expect(neonSafeBranchName(once)).toBe(once);
  });
});
