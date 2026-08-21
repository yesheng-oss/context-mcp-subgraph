Call the `context` MCP tool with `action: "resume"`, `project: "$ARGUMENTS"` (if no argument given, infer the project name from the current working directory name), and `rootPath: "<absolute path to the project root / git repo root>"`.

Both `project` and `rootPath` are required: `project` names the memory bucket, `rootPath` enables exact graph lookup and file sandboxing.

This loads:
- Recent decisions, bugs, and notes from past sessions
- Active plans
- ContextGraph status (built or not)

If `codegraph.built` is false in the response, immediately call `codegraph_build` on the project path before proceeding.
