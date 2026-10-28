# Security

Report vulnerabilities privately through GitHub: https://github.com/Overbaker/OpenSlime/security/advisories/new

Please include the affected version or commit, steps to reproduce, and impact. Do not open a public issue for security problems.

OpenSlime installs files into `~/.claude` and runs model CLIs through `codeagent-wrapper`, which starts Codex with its approval bypass unless `CODEX_REQUIRE_APPROVAL=true`. Review `/osm:impl` file allow-lists before running it on sensitive repositories.
