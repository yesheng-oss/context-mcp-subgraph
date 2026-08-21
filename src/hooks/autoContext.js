import { saveContext } from '../db.js';
import { fireAutoLink } from './autoLink.js';

export function saveAutoContext({ title, content, type, files, state, tags = [] }) {
  const entry = saveContext({
    project:   state.sessionProject || null,
    sessionId: state.sessionId || null,
    title,
    content,
    type,
    source: 'auto',
    tags,
    files: files || [],
  });
  fireAutoLink(entry.id, state);
  return entry;
}
