#!/usr/bin/env node

/**
 * Claude Code PreToolUse hook for context-mcp.
 *
 * Input (stdin JSON): { session_id, cwd, hook_event_name: "PreToolUse",
 *   tool_name, tool_input, permission_mode }
 *
 * This hook is intentionally conservative. It validates the hook pipeline
 * runs before Bash commands but never blocks or rewrites them (exit 0 =
 * allow). Keep policy decisions in CLAUDE.md or a dedicated security hook
 * if your team needs command blocking (exit 2 + stderr blocks the call).
 */

process.stdin.resume();
process.stdin.setEncoding('utf8');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (input.trim()) JSON.parse(input);
  } catch {
    // Do not interrupt the user's command because hook input changed.
  }
});
