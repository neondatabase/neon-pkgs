import { contextBranch, currentContextFile, readContextFile } from './context.js';
import { log } from './log.js';

/**
 * Offline fast path for `(config) status --current-branch` (used by shell prompts).
 *
 * Reading the pinned branch out of the local `.neon` file does not need the CLI's
 * full command tree, `@neondatabase/api-client`, or yargs — importing those is ~200ms,
 * which dwarfs the actual work. So the entry point ({@link file://./cli.ts}) calls this
 * BEFORE importing `index.js`, and only falls through to the full CLI when this returns
 * `false`. On the fast path the process loads only this module + `context.js`/`log.js`
 * (~25ms total incl. Node startup) instead of ~230ms.
 *
 * It mirrors the `--current-branch` short-circuit in `status()` (commands/config.ts):
 * print the pinned branch to stdout and exit 0, or print nothing + a `neonctl checkout`
 * hint on stderr and exit non-zero when no branch is pinned.
 *
 * Deliberately conservative: only the EXACT bare invocation is handled —
 * `status --current-branch` or `config status --current-branch` with no other args.
 * Anything else (extra flags like `--context-file`/`--output`, more args, etc.) returns
 * `false` and flows through the normal yargs pipeline, so behavior can never diverge —
 * the worst case is "not faster", never "wrong".
 *
 * @returns `true` if it handled the invocation (caller should NOT load the full CLI).
 */
export const tryCurrentBranchFastPath = (
  argv: string[],
  // `cwd` is overridable so tests can exercise the `.neon` walk-up without mutating
  // `process.cwd()` (which isn't allowed in vitest workers), mirroring currentContextFile.
  cwd: string = process.cwd(),
): boolean => {
  // argv is [execPath, scriptPath, ...userArgs].
  if (!isExactCurrentBranchInvocation(argv.slice(2))) {
    return false;
  }

  const branch = contextBranch(readContextFile(currentContextFile(cwd)));
  if (branch) {
    process.stdout.write(`${branch}\n`);
  } else {
    log.info(
      'No branch pinned. Run `neonctl checkout <branch>` to pin a branch and pull its env vars.',
    );
    process.exitCode = 1;
  }
  return true;
};

/**
 * True only for `status --current-branch` or `config status --current-branch` with no
 * other arguments. Any extra token (another flag, `--context-file`, `=`-style flags,
 * positional args) makes this false so the full CLI handles it.
 */
const isExactCurrentBranchInvocation = (args: string[]): boolean => {
  const rest =
    args[0] === 'status'
      ? args.slice(1)
      : args[0] === 'config' && args[1] === 'status'
        ? args.slice(2)
        : null;
  return rest !== null && rest.length === 1 && rest[0] === '--current-branch';
};
