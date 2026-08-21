---
mode: agent
description: "Build the ContextGraph (AST knowledge graph) for the current project"
---

Call `codegraph_build` with the current working directory as the path (or a path provided by the user).

This builds the ContextGraph for the project by parsing source files into an AST knowledge graph. Once built, use `codegraph_query` to answer structural questions about the codebase before reading files directly.

After the build completes, report total nodes, edges, and communities.
