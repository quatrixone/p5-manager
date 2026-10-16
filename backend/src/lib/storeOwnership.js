// An app-generated issue draft is unverified. Only issue acceptance, using
// GitHub's issue.user identity, authorizes an update or pins an owner id.
export function prepareStoreDraft(item, old, login) {
  if (typeof login !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) throw Object.assign(new Error('Enter your GitHub username'), { status: 400 });
  if (item.builtin_id && (!old || item.builtin_id !== old.builtin_id)) throw Object.assign(new Error('Curated builtin ids cannot be claimed through submissions'), { status: 400 });
  const draft = { ...(old || {}), ...item, author: login, version: old ? old.version + 1 : 1 };
  delete draft.github_owner_id;
  delete draft.owner;
  return draft;
}

export function ownsStoreItem(item, user) {
  if (!item || !user) return false;
  // The catalog pins an owner as owner.github_id; github_owner_id is what
  // items listed before that carried.
  const id = Number.isSafeInteger(item.owner?.github_id) ? item.owner.github_id
    : Number.isSafeInteger(item.github_owner_id) ? item.github_owner_id : null;
  if (id !== null) return id === user.id;
  return typeof item.author === 'string' && item.author.toLowerCase() === user.login.toLowerCase();
}
export function prepareStoreSubmission(item, old, user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1 || !/^[a-zA-Z0-9-]{1,39}$/.test(user?.login || '')) throw Object.assign(new Error('A verified GitHub submitter is required'), { status: 401 });
  if (old && !ownsStoreItem(old, user)) throw Object.assign(new Error('Only the owner can update this Marketplace item'), { status: 403 });
  if (item.builtin_id && (!old || item.builtin_id !== old.builtin_id)) throw Object.assign(new Error('Curated builtin ids cannot be claimed through submissions'), { status: 400 });
  return { ...(old || {}), ...item, author: user.login, github_owner_id: user.id, version: old ? old.version + 1 : 1 };
}
