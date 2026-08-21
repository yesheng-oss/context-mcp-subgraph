import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveAutoContext } from '../hooks/autoContext.js';
import { guardPath } from '../guard.js';

// Atomic write: write to .tmp → fsync → rename
// Guarantees the target is never left in a partial state if process dies mid-write
function atomicWrite(filePath, data) {
  const tmp = filePath + '.patch-' + randomUUID();
  try {
    const fd = openSync(tmp, 'w');
    writeSync(fd, data, 0, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, filePath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

const ROOT_NOTE = ' Sandboxed to project root — paths outside root are denied.';

export const definitions = [
  {
    name: 'create_dir',
    description: 'Create a directory (and any missing parent directories). Safe to call if already exists.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    outputSchema: { type: 'object', properties: { path: { type: 'string' }, existed: { type: 'boolean' }, message: { type: 'string' } } },
  },
  {
    name: 'list_dir',
    description: 'List the contents of a local directory.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    outputSchema: { type: 'object', properties: { directory: { type: 'string' }, items: { type: 'array' } } },
  },
  {
    name: 'read_file',
    description: 'Read the text contents of a local file.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    outputSchema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } } },
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an existing file.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    outputSchema: { type: 'object', properties: { file: { type: 'string' }, message: { type: 'string' } } },
  },
  {
    name: 'patch_file',
    description:
      `Apply targeted string replacement(s) to a file.\n` +
      `Single edit: pass old_str + new_str.\n` +
      `Multi edit:  pass edits:[{old_str, new_str, description?}] — atomic.\n` +
      `Use dry_run:true to validate without writing.` + ROOT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        edits:   { type: 'array', items: { type: 'object' } },
        dry_run: { type: 'boolean' },
        backup:  { type: 'boolean' },
      },
      required: ['path'],
    },
    outputSchema: { type: 'object' },
  },
  {
    name: 'delete_file',
    description: 'Delete a local file. Pass recursive:true to delete a directory and its contents.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean', description: 'Required to delete a directory. Defaults to false.' } }, required: ['path'] },
    outputSchema: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } },
  },
];

export async function handle(name, args, state) {
  switch (name) {
    case 'create_dir': {
      const dirPath = guardPath(args.path, state.projectRootPath);
      const existed = existsSync(dirPath);
      mkdirSync(dirPath, { recursive: true });
      return { path: dirPath, existed, message: existed ? `Already exists: ${dirPath}` : `Created: ${dirPath}` };
    }

    case 'list_dir': {
      const dirPath = guardPath(args.path || '.', state.projectRootPath);
      const items = readdirSync(dirPath).map(name => {
        const full = pathJoin(dirPath, name);
        try { const s = statSync(full); return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.size }; }
        catch { return { name, type: 'unknown' }; }
      }).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
      return { directory: dirPath, items };
    }

    case 'read_file': {
      const filePath = guardPath(args.path, state.projectRootPath);
      return { file: filePath, content: readFileSync(filePath, 'utf8') };
    }

    case 'write_file': {
      const filePath = guardPath(args.path, state.projectRootPath);
      mkdirSync(dirname(filePath), { recursive: true });
      atomicWrite(filePath, args.content);
      saveAutoContext({
        title:   `wrote ${filePath.split(/[\\/]/).pop()}`,
        content: `write_file: created/overwrote ${filePath}`,
        type:    'note',
        files:   [{ path: filePath, action: 'modified' }],
        tags:    ['file-write'],
        state,
      });
      return { file: filePath, message: `Successfully wrote: ${filePath}` };
    }

    case 'patch_file': {
      const filePath = guardPath(args.path, state.projectRootPath);
      if (!args.old_str && !args.edits?.length) throw new Error('old_str or edits[] required');

      const raw     = readFileSync(filePath, 'utf8');
      const hasCRLF = raw.includes('\r\n');
      const original = hasCRLF ? raw.replace(/\r\n/g, '\n') : raw;

      const editList = args.edits?.length
        ? args.edits.map((e, i) => ({ old_str: e.old_str.replace(/\r\n/g, '\n'), new_str: (e.new_str ?? '').replace(/\r\n/g, '\n'), description: e.description || `edit ${i + 1}` }))
        : [{ old_str: args.old_str.replace(/\r\n/g, '\n'), new_str: (args.new_str ?? '').replace(/\r\n/g, '\n'), description: 'edit 1' }];

      const resolved = editList.map((edit, i) => {
        const occ = original.split(edit.old_str).length - 1;
        if (occ === 0) throw new Error(`patch_file edit ${i + 1}: old_str not found in ${filePath}`);
        if (occ > 1)  throw new Error(`patch_file edit ${i + 1}: old_str matches ${occ} times — must match exactly once`);
        const pos = original.indexOf(edit.old_str);
        return { ...edit, pos, end: pos + edit.old_str.length, index: i + 1 };
      });

      const sorted = [...resolved].sort((a, b) => a.pos - b.pos);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].end > sorted[i + 1].pos) throw new Error(`patch_file: edit ${sorted[i].index} and ${sorted[i + 1].index} overlap`);
      }

      if (args.dry_run) {
        return { dry_run: true, file: filePath, edits: sorted.map(e => ({ index: e.index, description: e.description, match: true, position: e.pos })), message: `Dry run: all ${sorted.length} edit(s) matched.` };
      }

      if (args.backup) atomicWrite(filePath + '.bak', raw);

      let patched = original;
      for (const edit of [...sorted].reverse()) {
        patched = patched.slice(0, edit.pos) + edit.new_str + patched.slice(edit.end);
      }
      if (hasCRLF) patched = patched.replace(/\n/g, '\r\n');
      atomicWrite(filePath, patched);

      const totalRemoved = sorted.reduce((s, e) => s + e.old_str.split('\n').length, 0);
      const totalAdded   = sorted.reduce((s, e) => s + e.new_str.split('\n').length, 0);
      saveAutoContext({
        title:   `patched ${filePath.split(/[\\/]/).pop()}${sorted.length > 1 ? ` (${sorted.length} edits)` : ''}`,
        content: `patch_file: ${sorted.length} edit(s) in ${filePath}\n` +
                 sorted.map(e => `  ${e.description}: -${e.old_str.split('\n').length} +${e.new_str.split('\n').length} lines`).join('\n'),
        type:    'note',
        files:   [{ path: filePath, action: 'modified' }],
        tags:    ['file-patch'],
        state,
      });
      return { success: true, file: filePath, edits_applied: sorted.length,
        edits: sorted.map(e => ({ index: e.index, description: e.description, lines_removed: e.old_str.split('\n').length, lines_added: e.new_str.split('\n').length })),
        total_lines_removed: totalRemoved, total_lines_added: totalAdded,
        message: `Patched ${filePath.split(/[\\/]/).pop()}: ${sorted.length} edit(s), -${totalRemoved} +${totalAdded} lines.`,
      };
    }

    case 'delete_file': {
      const filePath = guardPath(args.path, state.projectRootPath);
      const isDir = existsSync(filePath) && statSync(filePath).isDirectory();
      if (isDir && !args.recursive) {
        throw new Error(`"${filePath}" is a directory. Pass recursive:true to delete it and its contents.`);
      }
      rmSync(filePath, { recursive: !!args.recursive });
      return { path: filePath, message: `Deleted: ${filePath}` };
    }

    default:
      throw new Error(`Unknown file tool: ${name}`);
  }
}
