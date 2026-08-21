#!/usr/bin/env node

/**
 * Hermes Agent post_tool_call shell hook for context-mcp.
 *
 * Input (stdin JSON): { hook_event_name: "post_tool_call", tool_name,
 *   tool_input, session_id, cwd, extra } — matcher: "terminal".
 *
 * Saves failed terminal commands to context-mcp so the next session can see
 * what broke. Exits silently when the command succeeded or the exit code
 * cannot be determined.
 *
 * Output (stdout): `{}` — non-blocking, informational only.
 */

import { spawnSync } from 'node:child_process';

process.stdin.resume();
process.stdin.setEncoding('utf8');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try {
    event = input.trim() ? JSON.parse(input) : {};
  } catch {
    event = {};
  }

  const toolInput = event.tool_input || {};
  const extra = event.extra || {};
  const command = toolInput.command || toolInput.cmd || '';
  const exitCode = extra.exit_code ?? extra.exitCode ?? extra.code;

  if (command && exitCode !== undefined && Number(exitCode) !== 0) {
    const output = String(extra.stderr || extra.stdout || extra.output || '').trim();
    const content = [
      `Command: ${command}`,
      `Exit code: ${exitCode}`,
      output ? `Output:\n${output.slice(0, 4000)}` : null,
    ].filter(Boolean).join('\n\n');

    spawnSync('ctx', [
      'save',
      '--project', (event.cwd || process.cwd()).split(/[\\/]/).pop() || 'default',
      '--type', 'bug',
      '--title', `Failed terminal command: ${command.slice(0, 80)}`,
      '--content', content,
    ], {
      encoding: 'utf8',
      shell: true,
      stdio: 'ignore',
    });
  }

  process.stdout.write('{}');
});
