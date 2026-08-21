---
mode: agent
description: "Save a note/decision/bug to context-mcp project memory"
argument-hint: "What to remember (e.g. 'fixed auth bug in src/auth.js')"
---

Call the `context` MCP tool with `action: "save"` to store a note for the current project.

Infer `project` from the current working directory name. `type` is always `"note"` (the only entry type besides `"compaction"`, which is reserved for session summaries). Auto-detect a category `tags` entry instead:
- bug/fix/error → `"bug"`
- task/done/complete/shipped/implemented → `"task"`
- decision/chose/decided/approach → `"decision"`
- config/env/secret/deploy → `"config"`
- omit if none match

Fill in `title` (up to 120 chars), `why`, `outcome`, and `files`. Confirm back to the user: title, tags, why, outcome, and project.
