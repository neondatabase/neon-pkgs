import yargs from 'yargs';

import { fillSingleProject } from '../utils/enrichers.js';
import { status } from './config.js';

/**
 * `neon status` is a top-level alias for `neon config status` — the most-reached-for
 * config subcommand. It mirrors that command's options (including `--current-branch`,
 * the offline branch probe) and delegates to the same `status` handler.
 *
 * Because it has a handler but no subcommands, `status` must also be listed in
 * `NO_SUBCOMMANDS_VERBS` (see index.ts) so the help-fallback middleware doesn't
 * intercept a bare `neon status`.
 */
export const command = 'status';
export const describe = "Show the branch's live Neon state (alias of `config status`)";

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 status [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
      'config-json': {
        describe:
          "Print only the branch's live config as neon.ts-shaped JSON " +
          '(services + branch tuning + preview), to stdout. Useful for ' +
          'scripting or copying into a neon.ts.',
        type: 'boolean',
        default: false,
      },
      'current-branch': {
        describe:
          'Print only the linked branch name from the local .neon file ' +
          '(no network). Exits non-zero when no branch is pinned.',
        type: 'boolean',
        default: false,
      },
    })
    .middleware(fillSingleProject as any);

export const handler = (args: yargs.Arguments) => status(args as any);
