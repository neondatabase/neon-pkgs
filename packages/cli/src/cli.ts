#!/usr/bin/env node

import { tryCurrentBranchFastPath } from './current_branch_fast_path.js';

// Fast path for the offline `(config) status --current-branch` probe (used by shell
// prompts): read the pinned branch from `.neon` without loading the full command tree,
// api-client, and yargs (~200ms). Falls through to the full CLI for everything else, so
// the heavy `index.js` is imported lazily and only when actually needed.
if (!tryCurrentBranchFastPath(process.argv)) {
  void import('./index.js');
}
