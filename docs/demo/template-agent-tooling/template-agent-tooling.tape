# Records docs/template-agent-tooling.md against the real skills and add-mcp CLIs.
# Run from the repository root with network access: vhs docs/demo/template-agent-tooling/template-agent-tooling.tape

Output docs/demo/template-agent-tooling/template-agent-tooling.gif
Output docs/demo/template-agent-tooling/template-agent-tooling.mp4

Require node
Require npx

Set Shell "bash"
Set FontSize 14
Set Width 1440
Set Height 960
Set Padding 24
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 30ms

Hide
Type `export DEMO="$PWD/docs/demo/template-agent-tooling" PS1='\[\e[1;32m\]❯\[\e[0m\] '` Enter
Type `for v in $(env | cut -d= -f1 | grep -E '^(CURSOR|CLAUDE)'); do unset "$v"; done; unset NEON_API_KEY` Enter
Type `cd "$(mktemp -d)" && ln -s "$DEMO/bootstrap.yaml" "$DEMO/install-template-tooling.mjs" . && clear` Enter
Sleep 500ms
Show

Type "# 1. The template's manifest entry declares the skills and MCP servers it wants" Enter
Sleep 500ms
Type "cat bootstrap.yaml" Enter
Sleep 5s

Type "# 2. neon has scaffolded the template. Its .env holds one of the two keys" Enter
Type "mkdir my-app && echo 'CONTEXT7_API_KEY=ctx7sk-demo' > my-app/.env" Enter
Sleep 2s
Type "clear" Enter

Type "# 3. Install on demand with the real skills and add-mcp CLIs. Nothing is bundled" Enter
Sleep 500ms
Type "node install-template-tooling.mjs ai-sdk my-app --agent cursor --agent claude-code" Enter
Wait+Screen@240s /Template tooling for/
Sleep 8s
Type "clear" Enter

Type "# 4. What landed in the project" Enter
Type "cd my-app && find . \( -type f -o -type l \) | sort" Enter
Sleep 3s
Type "cat .cursor/mcp.json; echo" Enter
Sleep 3s
Type "cat .gitignore" Enter
Sleep 5s
