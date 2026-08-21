---
description: "Build the ContextGraph (AST knowledge graph) for a project"
argument-hint: [path]
---

Call `codegraph_build` with the path `$ARGUMENTS`.

If no argument is given, use the current working directory.

This builds the ContextGraph for the project by parsing source files into an AST
knowledge graph. Once built, use `codegraph_query` to answer structural questions
about the codebase before reading files directly.

After the build completes, report total nodes, edges, and communities.
