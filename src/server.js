import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

import * as contextTool      from './tools/context.js';
import * as searchTool       from './tools/search.js';
import * as planTool          from './tools/plan.js';
import * as errorCheckTool   from './tools/errorCheck.js';
import * as fileTool         from './tools/fileTools.js';
import * as gitTool          from './tools/gitTools.js';
import * as codegraphTool    from './tools/codegraph.js';
import * as symbolDetailTool from './tools/symbolDetail.js';
import * as toolRegistryTool from './tools/toolRegistry.js';

const FILE_TOOL_NAMES      = new Set(fileTool.definitions.map(d => d.name));
const GIT_TOOL_NAMES       = new Set(gitTool.definitions.map(d => d.name));
const CODEGRAPH_TOOL_NAMES = codegraphTool.TOOL_NAMES;
const REGISTRY_TOOL_NAMES  = toolRegistryTool.TOOL_NAMES;

export function createServer({ enableFileTools = false, enableGitTools = getConfig().access_git === true } = {}) {
  const state = {
    sessionProject:  null,
    discussionId:    null,
    projectRootPath: null,
  };

  const server = new Server(
    { name: 'context-mcp', version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      contextTool.definition,
      searchTool.definition,
      planTool.definition,
      errorCheckTool.definition,
    ];
    if (enableFileTools) tools.push(...fileTool.definitions);
    if (enableGitTools)  tools.push(...gitTool.definitions);
    tools.push(...codegraphTool.definitions);
    tools.push(symbolDetailTool.definition);
    tools.push(...toolRegistryTool.definitions);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (FILE_TOOL_NAMES.has(name) && !enableFileTools) {
      throw new Error(`Tool "${name}" is only available in online (HTTP) mode.`);
    }
    if (GIT_TOOL_NAMES.has(name) && !enableGitTools) {
      throw new Error(`Tool "${name}" requires ACCESS_GIT=true.`);
    }

    try {
      let result;

      if (name === contextTool.definition.name) {
        result = await contextTool.handle(args, state);
      } else if (name === searchTool.definition.name) {
        result = await searchTool.handle(args, state);
      } else if (name === planTool.definition.name) {
        result = await planTool.handle(args, state);
      } else if (name === errorCheckTool.definition.name) {
        result = await errorCheckTool.handle(args, state);
      } else if (FILE_TOOL_NAMES.has(name)) {
        result = await fileTool.handle(name, args, state);
      } else if (GIT_TOOL_NAMES.has(name)) {
        result = await gitTool.handle(name, args, state);
      } else if (CODEGRAPH_TOOL_NAMES.has(name)) {
        result = codegraphTool.handle(name, args, state);
      } else if (name === symbolDetailTool.definition.name) {
        result = await symbolDetailTool.handle(args, state);
      } else if (REGISTRY_TOOL_NAMES.has(name)) {
        result = toolRegistryTool.handle(name);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}
