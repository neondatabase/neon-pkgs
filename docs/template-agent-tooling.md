# Template agent tooling

A bootstrap starter or a Function Registry template can suggest the skills, MCP servers, and
CLIs that make it pleasant to work on with a coding agent. `neon bootstrap` and
`neon functions new` install them on demand, after scaffolding, by running the upstream CLIs:

| Tooling | How it is installed |
| --- | --- |
| Skills | `npx -y skills@latest add <source> --skill <name>… --agent <id>… -y`, project scope |
| MCP servers | `npx -y add-mcp@2.6.0 <target> --name <name> -a <id>… -y`, project scope |
| npm CLIs | `npm install -g <package>@<version>` when `<name>` is not on PATH, only after the user confirms. pnpm or bun only when npm is missing |
| System CLIs | `<name> --version` is checked; install hints are printed, never run |

Nothing is bundled. The `add-mcp` pin is the CLI's own `add-mcp` dependency version, and
`agent_tooling_run.test.ts` fails if they drift.

![Recording: a template's agent block installed with the real skills and add-mcp CLIs](demo/template-agent-tooling/template-agent-tooling.gif)

The recording predates the CLI integration and runs the demo script in
`demo/template-agent-tooling/`. Re-record with
`vhs docs/demo/template-agent-tooling/template-agent-tooling.tape`.

## Format

The same `agent` block goes into a `bootstrap.yaml` entry and a registry `template.json`:

```yaml
agent:
  skills:
    - source: vercel/ai            # owner/repo, or an https git URL
      skills: [ai-sdk]
  mcp:
    - name: context7               # "neon" is reserved for neon mcp
      url: https://mcp.context7.com/mcp
      headers:
        CONTEXT7_API_KEY: ${CONTEXT7_API_KEY}
      recommended: false           # unchecked in the picker, skipped by -y
    - name: stripe
      command: [npx, -y, "@stripe/mcp", --tools=all]
      env:
        STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY}
  cli:
    - name: inngest
      npm: inngest-cli@1.4.2       # exact pin, installed globally unless `inngest` is on PATH
    - name: stripe
      minVersion: 1.21.0
      install: { brew: stripe/stripe-cli/stripe, url: https://docs.stripe.com/stripe-cli }
```

The JSON Schema is
[`demo/template-agent-tooling/template.schema.json`](demo/template-agent-tooling/template.schema.json):
the published `registry/schemas/template.schema.json` plus `agent` and its `$defs`, inline
because the CLI compiles that file on its own. The CLI does not depend on it being published:
it admits `agent` into the fetched schema (`allowTemplateAgentTooling`) and validates the block
in code (`parseTemplateAgentTooling` in `packages/cli/src/templates/agent_tooling.ts`). The two
accept and reject the same inputs, so update both together.

**Older CLIs.** The published template schema has `additionalProperties: false`, so CLIs before
this change reject a `template.json` that has `agent` until the schema in
`neondatabase/examples` is updated. Publish the schema first. Bootstrap's manifest has no schema,
and older CLIs ignore the key.

**Invalid blocks.** A malformed block in `bootstrap.yaml` drops only the block and the starter
is still offered. In a `template.json` it fails the template, like every other schema error there.

## Validation

Every string ends up in a consent prompt, a child process argv, or an agent's MCP config, so the
parser refuses anything a terminal, a shell, or an agent would interpret:

- Control, zero-width, and bidi characters, anywhere.
- `$` anywhere except a `${NAME}` placeholder (uppercase) in a header or env value. Agents expand
  `${env:NAME}`, `${NAME:-default}`, and `$NAME` in their own configs, so a template could
  otherwise read the user's environment into a request header.
- URLs that are not https, or that carry credentials.
- A stdio `command` whose executable is not a bare name (`npx`, `uvx`), or whose first argument
  contains whitespace: add-mcp splits its target on spaces, so the CLI passes
  `"<command[0]> <command[1]>"` as the target and every other argument through `--args`.
- Unknown fields, repeated names, and lists over 10 entries.

## Trust and consent

| Template | Terminal | `-y` / `--default` | `--template-tooling` |
| --- | --- | --- | --- |
| Neon's: the default bootstrap manifest with `source.owner: neondatabase`, or a registry entry without `source` | Pickers, recommended entries preselected | Installs the recommended skills and MCP servers; prints npm CLI global installs | Installs the recommended entries |
| Third-party: a registry `source.github`, any manifest or registry override (`NEON_BOOTSTRAP_MANIFEST_URL`, `NEON_FUNCTION_REGISTRY_*`) | Warning plus pickers, nothing preselected | Skipped, with a hint naming the flag | Installs the recommended entries |

`--no-template-tooling` skips it everywhere. A terminal asks three separate questions, skipping
any kind the template has none of: which skills (one choice per skill, regrouped per source so
each source is still one skills CLI run), which MCP servers, and which CLIs. Each choice shows
what it runs or writes: the skills source, the MCP URL or full command, the variables it needs,
and for an npm CLI the global install. `a` toggles a whole list.

A global install changes the machine, not the project, so it needs a decision the user made
for this run: picking the CLI in a terminal, or `--template-tooling`. `-y` alone leaves it as a
next step.

## Secrets

`${NAME}` placeholders are filled before add-mcp runs:

- **Neon's templates**: the environment, then the project's `.env`, then a password prompt in a
  terminal. Names starting with `NEON_`, `AWS_`, `AZURE_`, `GOOGLE_`, `GCP_`, `GH_`, `GITHUB_`,
  `GITLAB_`, `NPM_`, `SSH_`, or `PG`, plus `DATABASE_URL` and `NODE_AUTH_TOKEN`, are never read
  from the environment. They are only asked for.
- **Third-party templates**: only a prompt.

A server with an unfilled value is skipped, and the next steps print its command with
`"$NAME"` for the user's shell to fill. A config that git tracks is never given a secret. Once
one is written, the file is `chmod 600` and gitignored, the same as `neon mcp` does for API keys.
Failure output has resolved values redacted.

The one exposure the add-mcp CLI forces: it takes header and env values only as arguments,
so a secret is visible in the process list for the few seconds add-mcp runs.

## Agents

`bootstrap` targets the agents its Neon plugin, skills, or MCP step installed into, including
ones picked interactively. With no Neon step (`--no-agent-setup`) it falls back to the agents
detected in the project and the one running the command. `functions new` takes `--agent`, and
otherwise detects the same way. An existing MCP server of the same name, in any case, is left
unchanged.

## Not done yet

- `bootstrap --list-templates -o json` does not show the `agent` block.
- No telemetry fields for template tooling.
- No live e2e test that runs the real add-mcp CLI, like `plugins.e2e.test.ts` does for plugins.
- The published `template.schema.json` and `bootstrap.yaml` in `neondatabase/examples` still need
  the block.
