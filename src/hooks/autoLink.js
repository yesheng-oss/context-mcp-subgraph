import { linkContextToDiscussion } from '../db.js';

export function fireAutoLink(contextId, state) {
  if (state.discussionId) {
    linkContextToDiscussion({ discussionId: state.discussionId, contextId });
  }
}
