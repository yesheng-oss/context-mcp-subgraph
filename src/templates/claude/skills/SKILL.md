---
name: context-mcp
description: >
  Persistent memory + ContextGraph (codebase knowledge graph) for Claude.
  Use at the START of every conversation to resume project context. Use
  whenever the user mentions a project, asks to remember/save something,
  references past work, or says "pick up where we left off". Also use
  when the user asks about code structure, dependencies, or what exists
  in a codebase — query the ContextGraph before reading any files.
---

# Context-MCP

Persistent memory + codebase knowledge graph across every conversation.
`context.resume` starts every session. `codegraph_arch` shows module structure. `codegraph_query` finds specific symbols. Files only for bugs/logic.

---

## Subcommands

When invoked with an argument, act immediately:

**`/context-mcp resume`** — call `context` tool with `action:"resume"`, infer `project` from cwd, pass `rootPath`. Report what was returned.

**`/context-mcp save`** — call `context` tool with `action:"save"` to save the most recent thing worth keeping from this conversation. Use `type:"note"`, fill in `title`, `why`, `outcome`, `files` from context. Confirm what was saved.

---

## MANDATORY: Start of Every Conversation

Call `context` tool **before any tool or response** with:
- `action: "resume"`
- `project: "<basename of git repo root dir>"` — infer from `cwd` if not stated
- `rootPath: "<absolute path to git repo root>"` — required for sandbox + graph lookup

Returns:
- `recentEntries` — last 15 entries; newest 2 + high-signal entries have full content, rest have 200-char preview
- `activePlans` — in-progress plans; read them before starting any new work
- `codegraph` — `{ built: true/false, nodes, edges, communities }`
- `stats.totalEntries` — if ≥ 20, write a compaction summary before proceeding (see Rule 4)

Then:
- `codegraph.built: true` → use `codegraph_arch` for structure overview, `codegraph_query` for specific lookups
- `codegraph.built: false` → call `codegraph_build(path)` first

---

## When to Save Context (MANDATORY TRIGGERS)

Call `context.save` with `type: "note"` after finishing anything worth keeping:

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

## Plans (MANDATORY for multi-file work)

**Create a plan when:** editing 2+ files, multi-step implementation, refactor, multi-file bug fix.

**Skip plan for:** single-file edits, questions, simple config tweaks.

1. `plan.save` with name, content, project, planDir — before starting work
2. Work through plan
3. `plan.update status:"done"` when complete — deletes the plan

On `resume`, check `activePlans` — do not duplicate in-progress work.

---

## Auto-Summary Rule (MANDATORY)

When `resume` returns `stats.totalEntries ≥ 20`, call `context.save` **before the user's task**:

```
type: "compaction"  title: "Session summary — <date>"
content: "<what was built, decided, broke, current state>"
project: "<project>"
```

---

## Search Before Asking

If user references past work → `search` first. Never ask user to re-explain saved information.

---

## ContextGraph Pipeline

### Build (once per project)
```
codegraph_build(path)  →  AST graph: functions, classes, imports, edges
```

### Query tools
```
codegraph_arch(path)                     → module map: every file, exports, imports
codegraph_query(path, question?, node?)  → find symbol or answer structural question
codegraph_nodes(path, type)              → list all nodes of a type (class|function|module|file|struct|table)
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
| Architecture overview / what files exist | `codegraph_arch` |
| Where is function/class X defined? | `codegraph_query node:"X"` |
| What does module Y import? | `codegraph_query question:"..."` |
| List all classes/functions | `codegraph_nodes type:"class"` |
| Which functions have side effects / a given return type? | `codegraph_filter` |
| Most connected / central files | `codegraph_report` |
| What breaks if I change X? | `codegraph_affected node:"X"` |
| Show me just the code for function X | `get_symbol_detail name:"X"` |
| Which tools are dangerous? | `tool_registry` or `safety_policy` |

### When to reach for each graph tool

- **Unknown territory**: `codegraph_report` first — god nodes + surprises
- **Before any refactor or rename**: `codegraph_affected` — blast radius FIRST
- **"Show me just that function"**: `get_symbol_detail` — avoids reading the whole file
- **`search`** finds past decisions. **`codegraph_query`** finds code symbols. Different tools.

---

## Rules

1. `context.resume` first — before any tool or response
2. Always pass `project`
3. Save on task complete — `why` + `outcome` + `files`
4. Compaction at ≥ 20 entries — before starting task
5. Plan for multi-file work — `status:"done"` deletes it
6. Search before asking about past work
7. Graph tools before files — `codegraph_affected` before any refactor
