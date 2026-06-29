import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryCurrentBranchFastPath } from './current_branch_fast_path.js';

// argv prefix: [execPath, scriptPath, ...userArgs]
const ARGV = (...userArgs: string[]) => ['/usr/bin/node', 'cli.js', ...userArgs];

describe('tryCurrentBranchFastPath', () => {
  let cwd: string;
  let origExitCode: typeof process.exitCode;
  let out: string[];
  let err: string[];
  let origOut: typeof process.stdout.write;
  let origErr: typeof process.stderr.write;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-fastpath-'));
    origExitCode = process.exitCode;
    process.exitCode = 0;
    out = [];
    err = [];
    origOut = process.stdout.write.bind(process.stdout);
    origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => {
      out.push(c.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(c.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExitCode;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('handles `status --current-branch`: prints the pinned branch, exit 0', () => {
    writeFileSync(join(cwd, '.neon'), JSON.stringify({ branch: 'my-feature' }));
    expect(
      tryCurrentBranchFastPath(ARGV('status', '--current-branch'), cwd),
    ).toBe(true);
    expect(out.join('')).toBe('my-feature\n');
    expect(process.exitCode).toBe(0);
  });

  it('handles `config status --current-branch` identically', () => {
    writeFileSync(join(cwd, '.neon'), JSON.stringify({ branch: 'main' }));
    expect(
      tryCurrentBranchFastPath(
        ARGV('config', 'status', '--current-branch'),
        cwd,
      ),
    ).toBe(true);
    expect(out.join('')).toBe('main\n');
  });

  it('falls back to the legacy `branchId` field (matches contextBranch)', () => {
    writeFileSync(join(cwd, '.neon'), JSON.stringify({ branchId: 'br-legacy' }));
    expect(
      tryCurrentBranchFastPath(ARGV('status', '--current-branch'), cwd),
    ).toBe(true);
    expect(out.join('')).toBe('br-legacy\n');
  });

  it('no branch pinned: empty stdout, stderr hint, non-zero exit (still handled)', () => {
    writeFileSync(join(cwd, '.neon'), JSON.stringify({ projectId: 'p' }));
    expect(
      tryCurrentBranchFastPath(ARGV('status', '--current-branch'), cwd),
    ).toBe(true);
    expect(out.join('')).toBe('');
    expect(err.join('')).toContain('Run `neonctl checkout <branch>`');
    expect(process.exitCode).toBe(1);
  });

  it('returns false (fall through to the full CLI) for anything but the exact invocation', () => {
    const fallThrough = [
      ['projects', 'list'],
      ['status'],
      ['config', 'status'],
      ['config', 'plan', '--current-branch'],
      ['status', '--current-branch', '--output', 'json'],
      ['config', 'status', '--current-branch', '--config-json'],
      ['status', '--current-branch', 'extra'],
      [],
    ];
    for (const args of fallThrough) {
      expect(tryCurrentBranchFastPath(ARGV(...args), cwd)).toBe(false);
    }
    // Fall-through must not print anything.
    expect(out.join('')).toBe('');
    expect(err.join('')).toBe('');
  });
});
