#!/usr/bin/env node

/**
 * Antigravity PostToolUse hook for context-mcp.
 *
 * Input (stdin JSON): { stepIdx, error, conversationId, workspacePaths,
 *   transcriptPath, artifactDirectoryPath } — matcher: "run_command".
 *
 * ponytail: PostToolUse doesn't carry the tool's args (only PreToolUse does),
 * so this can't report the exact failing command — only that a run_command
 * step failed. Good enough signal for "something broke here" across sessions.
 *
 * Output (stdout): always `{}` per the Antigravity hook contract.
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

  const error = String(event.error || '').trim();
  if (error) {
    const workspace = (event.workspacePaths || [])[0] || process.cwd();
    spawnSync('ctx', [
      'save',
      '--project', workspace.split(/[\\/]/).pop() || 'default',
      '--type', 'bug',
      '--title', `Failed run_command at step ${event.stepIdx ?? '?'}`,
      '--content', error.slice(0, 4000),
    ], {
      encoding: 'utf8',
      shell: true,
      stdio: 'ignore',
    });
  }

  process.stdout.write('{}');
});
