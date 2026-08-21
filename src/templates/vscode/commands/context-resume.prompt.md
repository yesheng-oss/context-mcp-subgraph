---
mode: agent
description: "Resume project memory + ContextGraph from context-mcp"
---

Call the `context` MCP tool with `action: "resume"`, infer `project` from the current working directory name, and pass `rootPath` as the absolute path to the git repo root.

Both `project` and `rootPath` are required: `project` names the memory bucket, `rootPath` enables exact graph lookup and file sandboxing.

This loads:
- Recent decisions, bugs, and notes from past sessions
- Active plans
- ContextGraph status (built or not)

If `codegraph.built` is false in the response, immediately call `codegraph_build` on the project path before proceeding.
