---
name: save-context
description: >
  Saves a decision, fix, feature, or discovery to persistent memory via
  context.save. Use whenever the user says "save this" / "remember this",
  or immediately after finishing a task, fix, or non-obvious discovery.
---

# Save Context

Call the `context` MCP tool with `action: "save"` to store a note for the
current project.

Determine:

- `project`: infer from the current workspace directory name if not specified.
- `title`: first sentence or phrase, up to 120 chars.
- `why`: why it mattered, what problem it solved, or what constraint it revealed.
- `outcome`: what changed, what was verified, what shipped, and which files were affected.
- `files`: list of files changed, if any.
- `content`: full description of what happened.
- `type`: `"note"` for everything, except a full session summary on
  "compact now" / "compress memory", which uses `"compaction"`.

Confirm to the user: title, why, outcome, and project.
