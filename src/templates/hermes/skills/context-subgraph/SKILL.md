---
name: context-subgraph
description: Retrieves a compact, relationship-aware code context before answering architecture or refactoring questions.
---

# Context Subgraph

Use the `codegraph_context` MCP tool before reading many files for a codebase
question. It returns the most relevant code entities and their dependency,
caller, import, inheritance, or implementation paths within a token budget.

## Procedure

1. Ensure the project graph exists; call `codegraph_build` when needed.
2. Call `codegraph_context` with the current task, project root, `max_hops: 2`,
   and a token budget appropriate to the task.
3. Use the returned nodes and edges to decide which files or symbols require
   direct inspection.
4. Treat `dropped_count` and `has_more` as evidence that the graph context was
   budgeted; do not assume omitted nodes are irrelevant.

## Recommended defaults

- `max_hops: 2` for implementation and refactoring questions.
- `top_k: 5` for focused tasks.
- `token_budget: 2000` for normal coding questions.

## Verification

The response should include `nodes`, `edges`, `tokens_used`, `dropped_count`,
and `has_more`. Preserve relationship paths when explaining why a node was
included.
