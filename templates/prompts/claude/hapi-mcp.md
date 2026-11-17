# HAPI MCP peer dispatch (Claude)

Read this once per stage when `mcp__hapi__spawn_peer` (or `spawn_peer`) is present in your tool list and `$ARGUMENTS` does not include `--no-hapi-mcp`.

Running inside HAPI gives external models first-class, inspectable HAPI sessions linked under this session. Outside HAPI (or if peer tools are disabled/unavailable, or the opt-out flag is set), fall back to `codeagent-wrapper`.

## Backend flavor map
- `antigravity` -> `agy`
- `codex`, `claude`, `grok`, `kimi`, `opencode`, `pi` -> unchanged
- `gemini` -> retired from HAPI creatable flavors; keep on `codeagent-wrapper`

## Fresh calls (`research`, `plan`, `review`, initial `impl` task)
1. Keep the exact brief and any `ROLE_FILE`: if a step references `~/.claude/.ccg/prompts/<backend>/<role>.md`, read that file first and prepend its instructions to the peer remit.
2. Call `mcp__hapi__spawn_peer` with:
   - `directory`: resolved `<WORKDIR>`
   - `agent`: mapped HAPI flavor
   - `name`: concise stage label such as `osm:<stage>:<backend>`
   - `message`: the full role instructions and stage brief
   - `waitForReply`: `true`
3. For parallel stages (`codex` + `antigravity`), emit both `spawn_peer` calls in ONE message, then end your turn and wait for HAPI to deliver both replies automatically (do not poll).
4. Save each returned `sessionId` instead of a wrapper `SESSION_ID`.

## Follow-up fixes (`resume` in `/osm:impl`)
- Call `mcp__hapi__ping_peer` with `sessionIdPrefix` set to the saved child `sessionId`, `message` carrying `file:line`, problem, and expected result, `wake: true`, and `waitForReply: true`. End your turn to receive the reply.
- If a writer fails or peer tools are disabled mid-run, retry once or fall back to `codeagent-wrapper` with the exact same brief.
