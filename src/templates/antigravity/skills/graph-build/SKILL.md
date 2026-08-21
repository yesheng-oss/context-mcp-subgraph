---
name: graph-build
description: >
  Builds the ContextGraph codebase knowledge graph via codegraph_build. Use
  when a project has no graph yet, when the user asks to build or rebuild
  the graph, or after adding/renaming many files.
---

# Graph Build

Call `codegraph_build` with the path to the project root (current working
directory if not otherwise specified).

This builds the ContextGraph for the project by parsing source files into an
AST knowledge graph. Once built, use `codegraph_query`, `codegraph_arch`,
`codegraph_nodes`, `codegraph_filter`, `codegraph_report`, and
`codegraph_affected` to answer structural questions about the codebase before
reading files directly. Use `get_symbol_detail` to read just one
function/class instead of a whole file. `tool_registry`/`safety_policy` list
which tools need confirmation before use.

After the build completes, report total nodes, edges, and communities.
