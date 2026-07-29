---
"neon": patch
"neonctl": patch
---

`neon --help` no longer prints the value of `NEON_API_KEY`.

The global `--api-key` option took its yargs `default` from `process.env.NEON_API_KEY`, and yargs renders an option's default into every help screen it produces. With the variable exported — the normal setup in CI and in any shell that sources a `.env` — the key was printed verbatim on `neon --help` and on every subcommand's `--help`, so it reached CI logs, terminal recordings, and pasted bug reports:

```
--api-key
└────────────────>  API key [string] [default: "napi_1a2b3c…"]
```

Help now names the variable instead of its value:

```
--api-key
└────────────────>  API key [string] [default: NEON_API_KEY]
```

Resolution is unchanged: `--api-key` wins, `NEON_API_KEY` is used when the flag is absent, and stored credentials are used when neither is set. The environment lookup moved out of the option default into a middleware that runs after help has been rendered.
