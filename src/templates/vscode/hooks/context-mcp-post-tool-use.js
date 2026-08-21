#!/usr/bin/env node

/**
 * VS Code Copilot PostToolUse hook for context-mcp.
 *
 * Input (stdin JSON): { hook_event_name: "PostToolUse", tool_name,
 *   tool_input: { command }, tool_output: { exit_code, stdout, stderr }, cwd }
 *
 * Saves failed shell commands to context-mcp so the next session can see
 * what broke. Exits silently when the command succeeded or exit code is unknown.
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
    return;
  }

  const toolInput = event.tool_input || {};
  // VS Code uses tool_output (not tool_response) for the result object
  const toolResult = typeof event.tool_output === 'object' && event.tool_output !== null
    ? event.tool_output
    : typeof event.tool_response === 'object' && event.tool_response !== null
      ? event.tool_response
      : {};
  const command = toolInput.command || toolInput.cmd || '';
  const exitCode = toolResult.exit_code ?? toolResult.exitCode ?? toolResult.code
    ?? event.exit_code ?? event.exitCode;

  if (!command || exitCode === undefined || Number(exitCode) === 0) return;

  const output = String(
    toolResult.stderr || toolResult.stdout || toolResult.output || '',
  ).trim();

  const content = [
    `Command: ${command}`,
    `Exit code: ${exitCode}`,
    output ? `Output:\n${output.slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n\n');

  spawnSync('ctx', [
    'save',
    '--project', (event.cwd || process.cwd()).split(/[\\/]/).pop() || 'default',
    '--type', 'bug',
    '--title', `Failed shell command: ${command.slice(0, 80)}`,
    '--content', content,
  ], { encoding: 'utf8', shell: true, stdio: 'ignore' });
});
