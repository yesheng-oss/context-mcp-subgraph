---
name: context-mcp
description: >
  Persistent memory + ContextGraph for Claude.
  Use at the START of every conversation to resume project context.
  Use whenever the user mentions a project, asks to remember/save something,
  references past work, or says "pick up where we left off".
  Also use when the user asks about code structure — query ContextGraph before reading any files.
---

# Context-MCP — Claude Usage Guide

Persistent memory + codebase knowledge graph across every conversation.
`context.resume` starts every session. `codegraph_arch` shows module structure. `codegraph_query` finds specific symbols. Files only for bugs/logic.

---

## 1. Start of Every Conversation (MANDATORY)

Call `context` tool **before any tool or response**:
- `action: "resume"`
- `project: "<basename of git repo root>"` — infer from cwd
- `rootPath: "<absolute path to git repo root>"` — required

Returns:
- `recentEntries` — last 15 entries; newest 5 have full content, rest have 200-char preview
- `activePlans` — in-progress plans; read them before starting any new work
- `codegraph` — `{ built: true/false, nodes, edges }`
- `stats.totalEntries` — if ≥ 20, write a compaction summary before proceeding (see Rule 4)

Then:
- `codegraph.built: true` → use `codegraph_arch` for structure overview, `codegraph_query` for specific lookups
- `codegraph.built: false` → call `codegraph_build(path)` first

---

## 2. When to Save Context (MANDATORY TRIGGERS)

Call `context.save` with `type: "note"` whenever you finish something or discover something worth keeping:

```
context.save
  project: "<project>"
  title:   "<what was done — up to 120 chars>"
  why:     "<why it mattered>"
  outcome: "<what the result was>"
  files:   ["src/file.js", ...]
```

**Save immediately after:**
- Task / fix / feature complete
- Decision made (architecture, library, approach)
- Discovery — non-obvious behavior, constraint, gotcha
- Config / env / deploy info
- Graph build complete — include nodes/edges count in content
- User says "save this" / "remember this"

**Manual compaction** — "compact now", "compress memory", "clean up context":
Save a full session summary as `type: "compaction"`. Server removes old entries using it.

**Do NOT save:** routine reads, search results, explanations of existing code, dead-end debugging.

---

## 3. Plans (MANDATORY for multi-file work)

**Create a plan when:** editing 2+ files, multi-step implementation, refactor, multi-file bug fix.

**Skip plan for:** single-file edits, questions, simple config tweaks.

1. Call `plan.save` with `name`, `content` (full plan in markdown), `project`, `planDir` before starting
2. Work through the plan
3. Call `plan.update status:"done"` when complete — this deletes the plan

On `resume`, if `activePlans` is non-empty — read them before starting new work. Do not create a duplicate.

---

## 4. Auto-Summary Rule (MANDATORY)

When `resume` returns `stats.totalEntries ≥ 20`, call `context.save` **before doing anything else**:

```
context.save
  type:    "compaction"
  title:   "Session summary — <YYYY-MM-DD>"
  content: "<what was built, decided, broke, current state>"
  project: "<project>"
```

---

## 5. Search Before Asking

If the user references past work → call `search` first:
```
search  query: "<what they're referencing>"  project: "<project>"
```

---

## 6. ContextGraph Pipeline

### Build (once per project)
```
codegraph_build(path)
```

### Query tools
```
codegraph_arch(path, limit?)             → module map: every file, its exports, its imports
codegraph_query(path, question?, node?)  → find function/class/file or answer structural question
codegraph_nodes(path, type)              → list all nodes of a type
codegraph_filter(path, ...)              → predicate filter (side_effect, return_type, called_by, exported, file_pattern) — no file reads
codegraph_report(path)                   → god nodes, clusters, structural analysis
codegraph_affected(path, node, depth?)   → blast radius BFS — what breaks if X changes?
codegraph_html(path, formats?)           → regenerate visualizations (auto-runs on every build)
get_symbol_detail(name, path)            → source code for one function/class — no full file read
tool_registry()                          → which tools have side effects + approval requirements
safety_policy()                          → which actions need user confirmation
```

| Question | Tool |
|---|---|
| What files exist and what do they export? | `codegraph_arch` |
| Where is function X defined? | `codegraph_query node:"X"` |
| What does module Y depend on? | `codegraph_query question:"what does Y import?"` |
| What are all the classes? | `codegraph_nodes type:"class"` |
| Which functions have side effects / a given return type? | `codegraph_filter` |
| Most connected files / god nodes? | `codegraph_report` |
| What breaks if I change X? | `codegraph_affected node:"X"` |
| Show me only the code for function X? | `get_symbol_detail name:"X"` |
| Which tools have side effects? | `tool_registry` |

### When to reach for each graph tool

- **Unknown territory** (first look at any codebase): `codegraph_report` — shows bottlenecks + surprises first
- **"Where is X defined?"**: `codegraph_query node:"X"` — faster than grep
- **"What does this module do?"**: `codegraph_arch` — static module map, no reads needed
- **Before any refactor or rename**: `codegraph_affected node:"X"` — see blast radius FIRST
- **"List all classes/functions"**: `codegraph_nodes type:"class"` or `type:"function"`
- **Files changed since last session**: `codegraph_build` is incremental — re-run after adding files
- **"Show me just that function"**: `get_symbol_detail` — avoids reading the whole file

**Never read files for structure questions — use graph tools first.**
**`search` finds past decisions. `codegraph_query` finds code symbols. Different tools.**

---

## 7. Rules

1. `context.resume` first — before any tool or response
2. Always pass `project`
3. Save on task complete — `why` + `outcome` + `files`
4. Compaction at ≥ 20 entries — before starting the task
5. Plan for multi-file work — save before starting, `status:"done"` deletes it
6. Search before asking about past work
7. Graph tools before files
