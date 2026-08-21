#!/usr/bin/env node

/**
 * Codex PreToolUse hook for context-mcp.
 *
 * This hook is intentionally conservative. It validates that Codex can run the
 * project-local hook pipeline before Bash commands, but it does not block or
 * rewrite commands. Keep policy decisions in AGENTS.md or a dedicated security
 * hook if your team needs command blocking.
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
