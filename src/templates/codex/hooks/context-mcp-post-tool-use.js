#!/usr/bin/env node

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

  const toolInput = event.tool_input || event.toolInput || {};
  const toolResult = event.tool_response || event.toolResponse || event.result || {};
  const command = toolInput.command || toolInput.cmd || event.command || '';
  const exitCode = toolResult.exit_code ?? toolResult.exitCode ?? event.exit_code ?? event.exitCode;

  if (!command || exitCode === undefined || Number(exitCode) === 0) return;

  const output = String(
    toolResult.stderr || toolResult.stdout || toolResult.output || event.output || '',
  ).trim();

  const content = [
    `Command: ${command}`,
    `Exit code: ${exitCode}`,
    output ? `Output:\n${output.slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n\n');

  spawnSync('ctx', [
    'save',
    '--project', process.cwd().split(/[\\/]/).pop() || 'default',
    '--type', 'bug',
    '--title', `Failed shell command: ${command.slice(0, 80)}`,
    '--content', content,
  ], {
    encoding: 'utf8',
    shell: true,
    stdio: 'ignore',
  });
});
