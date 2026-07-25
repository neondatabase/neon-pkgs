---
"@neon/env": patch
---

Restore editor autocomplete for `parseEnv`'s function-slug scope. Typing
`parseEnv(config, "…")` offered no completions, so the declared slugs of
`preview.functions` had to be recalled by hand (the slugs were already
type-checked — an undeclared one was always a type error — only the suggestions
were missing). The cause was overload order: an editor takes string-literal
completions from the first candidate overload, and the key-array overload was
declared first, so the expected type of the argument was read as an array, which
has no literal completions. The slug overload now comes first and the slugs
autocomplete. A policy that declares no functions at all also reports a readable
hint instead of the opaque `Type '"x"' is not assignable to type 'never'`.
