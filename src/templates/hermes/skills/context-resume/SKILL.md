---
name: context-resume
description: Resumes persistent memory and codebase graph status for context-mcp. Use at the start of every conversation, before any other tool call.
---

# Context Resume

Call the `context` MCP tool with `action: "resume"`, `project` inferred from
the current workspace directory name, and `rootPath` set to the absolute
path of the project root (git repo root if one exists).

Both `project` and `rootPath` are required: `project` names the memory
bucket, `rootPath` enables exact graph lookup and file sandboxing.

## When to Use

- At the start of every conversation, before any other tool or response
- Whenever the user mentions a project or asks to pick up past work

## Procedure

1. Call `context` with `action: "resume"`, `project`, `rootPath`.
2. This loads recent decisions/bugs/notes, active plans, and ContextGraph status.
3. If `codegraph.built` is false, call `codegraph_build` on the project path
   before doing anything else.
4. If `stats.totalEntries >= 20`, save a `type: "compaction"` session summary
   before starting the user's task.

## Verification

The response should include `recentEntries`, `activePlans`, and `codegraph`.
