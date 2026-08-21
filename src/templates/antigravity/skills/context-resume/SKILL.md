---
name: context-resume
description: >
  Resumes persistent memory and codebase graph status for context-mcp. Use at
  the start of every conversation, before any other tool call or response,
  and whenever the user mentions a project or asks to pick up past work.
---

# Context Resume

Call the `context` MCP tool with `action: "resume"`, `project` inferred from
the current workspace directory name, and `rootPath` set to the absolute
path of the project root (git repo root if one exists).

Both `project` and `rootPath` are required: `project` names the memory
bucket, `rootPath` enables exact graph lookup and file sandboxing.

This loads:
- Recent decisions, bugs, and notes from past sessions
- Active plans
- ContextGraph status (built or not)

If `codegraph.built` is false in the response, call `codegraph_build` on the
project path before proceeding with anything else.
