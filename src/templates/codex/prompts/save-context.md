---
description: "Save a note/decision/bug to context-mcp project memory"
argument-hint: [what to remember]
---

Call the `context` MCP tool with `action: "save"` to store a note for the
current project.

Parse the following to determine the fields: $ARGUMENTS

- `project`: infer from current working directory name if not specified.
- `title`: first sentence or phrase, up to 120 chars.
- `why`: why it mattered, what problem it solved, or what constraint it revealed.
- `outcome`: what changed, what was verified, what shipped, and which files were affected.
- `files`: list of files changed, if any.
- `content`: full argument text.
- `type`: always `"note"` (the only entry type besides `"compaction"`, which is reserved for session summaries).
- `tags`: auto-detect a category tag from the content — `bug`/`fix`/`error` -> `"bug"`, `task`/`done`/`complete`/`shipped`/`implemented` -> `"task"`, `decision`/`chose`/`decided`/`approach` -> `"decision"`, `config`/`env`/`secret`/`deploy` -> `"config"` — omit if none match.

Confirm to the user: title, tags, why, outcome, and project.
