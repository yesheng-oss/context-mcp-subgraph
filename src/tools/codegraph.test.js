import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callPython } from './codegraph.js';

test('Python bridge is asynchronous and parses a structured response', async () => {
  const result = await callPython('test_tool', {}, {
    command: process.execPath,
    commandArgs: ['-e', "process.stdin.on('data',()=>process.stdout.write('{\\\"ok\\\":true}'))"],
  });
  assert.equal(result.ok, true);
  assert.equal(result._meta.cache_hit, false);
});

test('read-only graph queries are cached per graph revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-mcp-'));
  mkdirSync(join(root, 'codegraph-cache'));
  writeFileSync(join(root, 'codegraph-cache', 'graph.json'), '{}');
  const options = {
    command: process.execPath,
    commandArgs: ['-e', "process.stdin.on('data',()=>process.stdout.write('{\\\"nodes\\\":[]}'))"],
  };
  const first = await callPython('codegraph_context', { path: root, question: 'Auth' }, options);
  const second = await callPython('codegraph_context', { path: root, question: 'Auth' }, options);
  assert.equal(first._meta.cache_hit, false);
  assert.equal(second._meta.cache_hit, true);
});
