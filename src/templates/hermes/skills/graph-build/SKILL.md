---
name: graph-build
description: Builds the ContextGraph codebase knowledge graph via codegraph_build. Use when a project has no graph yet or after adding/renaming many files.
---

# Graph Build

Call `codegraph_build` with the path to the project root (current working
directory if not otherwise specified).

## When to Use

- A project has no ContextGraph yet (`codegraph.built: false` on resume)
- The user asks to build or rebuild the graph
- Many files were added, removed, or renamed since the last build

## Procedure

1. Call `codegraph_build(path)`.
2. Once built, use `codegraph_query`, `codegraph_arch`, `codegraph_nodes`,
   `codegraph_filter`, `codegraph_report`, and `codegraph_affected` to answer
   structural questions about the codebase before reading files directly.
   Use `get_symbol_detail` to read just one function/class instead of a whole
   file. `tool_registry`/`safety_policy` list which tools need confirmation.
3. Report total nodes, edges, and communities after the build completes.
