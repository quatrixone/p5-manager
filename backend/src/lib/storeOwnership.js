// An app-generated issue draft is unverified. Only issue acceptance, using
// GitHub's issue.user identity, authorizes an update or pins an owner id.
export function prepareStoreDraft(item, old, login) {
  if (typeof login !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) throw Object.assign(new Error('Enter your GitHub username'), { status: 400 });
  if (item.builtin_id && (!old || item.builtin_id !== old.builtin_id)) throw Object.assign(new Error('Curated builtin ids cannot be claimed through submissions'), { status: 400 });
  const draft = { ...(old || {}), ...item, author: login, version: old ? old.version + 1 : 1 };
  delete draft.github_owner_id;
  return draft;
}

export function ownsStoreItem(item, user) {
  if (!item || !user) return false;
  if (Number.isSafeInteger(item.github_owner_id)) return item.github_owner_id === user.id;
  return typeof item.author === 'string' && item.author.toLowerCase() === user.login.toLowerCase();
}
export function prepareStoreSubmission(item, old, user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1 || !/^[a-zA-Z0-9-]{1,39}$/.test(user?.login || '')) throw Object.assign(new Error('A verified GitHub submitter is required'), { status: 401 });
  if (old && !ownsStoreItem(old, user)) throw Object.assign(new Error('Only the owner can update this Marketplace item'), { status: 403 });
  if (item.builtin_id && (!old || item.builtin_id !== old.builtin_id)) throw Object.assign(new Error('Curated builtin ids cannot be claimed through submissions'), { status: 400 });
  return { ...(old || {}), ...item, author: user.login, github_owner_id: user.id, version: old ? old.version + 1 : 1 };
}
