import { parsePsnAccountId } from './psnAccount.js';

// Linking Sony never replaces an existing console identity or pairing.
export function linkSonyIdentity(profile, accountId, onlineId) {
  const sonyId = parsePsnAccountId(accountId);
  if (!sonyId) throw new Error('Invalid PSN account ID');
  const consoleId = profile.psn_account_id || sonyId;
  const matches = parsePsnAccountId(consoleId) === sonyId;
  return {
    sony_account_id: sonyId,
    sony_online_id: onlineId || null,
    psn_account_id: consoleId,
    psn_online_id: matches ? (onlineId || profile.psn_online_id || null) : (profile.psn_online_id || null),
    account_mismatch: !matches,
  };
}
