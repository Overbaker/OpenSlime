# OpenSlime design principles

OpenSlime keeps multi-agent collaboration as small as it can be. Every addition has to beat a single Claude loop with skills on speed, cost or quality.

Background: Anthropic's Applied AI team (22 Oct 2026) found a single agent loop with skills often beats both one big prompt and a subagent design, at lower cost and latency. One customer's single loop ran the same work about twice as fast as its multi-agent harness. Summary: [clauding.de](https://clauding.de/en/posts/claude-platform-subagenten-hauptschleife/).

## Rules

1. **One main loop.** Claude plans, decides and talks to the user. No routers, planners or per-domain specialist agents in front of it.
2. **Progressive disclosure.** Knowledge ships as on-demand skills, prompts as role files read at call time. Nothing is injected per turn: no hooks, no always-on routing rules.
3. **External models only where they earn it.** Use them for:
   - independent verification, in a fresh session that never wrote the code;
   - parallel work with disjoint file scopes and its own context, discarded afterwards;
   - a different permission or cost boundary (e.g. a cheaper model writes tests).
4. **Thin handoffs.** A worker brief states the goal, the exact files it may change, constraints and a verify command. A worker report states what changed, what was verified and what was not checked.
5. **One voice.** One output style, one reviewer prompt shared by all backends. Fix contradictions instead of adding prompt layers.
6. **Evaluate the whole chain, not the parts.** A change to prompts or routing is judged on end-to-end tasks, not on one subtask's score.

## Out of scope

Agent swarms, per-team subagents, orchestrators on top of orchestrators, regex quality gates, and DSH as a host. Conway's law: an agent per team turns the architecture into the org chart.
