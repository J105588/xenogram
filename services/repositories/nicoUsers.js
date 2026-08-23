const { db } = require('./db');

/**
 * その鯖が監視対象にしているニコニコユーザーID一覧を取得する。
 *
 * 以前は登録が0件のとき .env の NICO_USER_IDS にフォールバックしていたが、
 * マルチテナント化した今この挙動は危険だった: Botを新しいサーバーに入れた瞬間、
 * そのサーバーが何も登録していないのに他人のアカウントの監視が始まり、
 * その投稿者の全動画を「新着」として登録・通知してしまう。
 * 登録が無い鯖は「誰も監視しない」＝空配列を返す。
 */
function getNicoUserIds(guildId) {
  return db.prepare('SELECT user_id FROM nico_users WHERE guild_id = ? ORDER BY added_at ASC')
    .all(guildId)
    .map((r) => r.user_id);
}

function getNicoUsersDetailed(guildId) {
  return db.prepare('SELECT user_id, label, added_at FROM nico_users WHERE guild_id = ? ORDER BY added_at ASC')
    .all(guildId);
}

function addNicoUser(guildId, userId, label = null) {
  try {
    db.prepare('INSERT INTO nico_users (guild_id, user_id, label, added_at) VALUES (?, ?, ?, ?)')
      .run(guildId, userId, label, new Date().toISOString());
    return { ok: true };
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    console.error('Error adding nico user:', error);
    return { ok: false, reason: 'error' };
  }
}

function getNicoUser(guildId, userId) {
  const row = db.prepare('SELECT user_id, label, added_at FROM nico_users WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  return row || null;
}

/**
 * 登録済みユーザーのIDやラベルを編集する。
 * user_id は主キーの一部なので、変更すると別IDへの付け替えになる（重複時は duplicate）。
 *
 * @param {string} guildId
 * @param {string} userId 現在のユーザーID
 * @param {Object} patch { userId?: string, label?: string|null }
 * @returns {{ok: boolean, data?: Object, reason?: string}}
 */
function updateNicoUser(guildId, userId, patch) {
  const existing = getNicoUser(guildId, userId);
  if (!existing) return { ok: false, reason: 'not_found' };

  const sets = [];
  const params = [];
  if ('userId' in patch) { sets.push('user_id = ?'); params.push(patch.userId); }
  if ('label' in patch) { sets.push('label = ?'); params.push(patch.label); }
  if (!sets.length) return { ok: true, data: existing };

  try {
    db.prepare(`UPDATE nico_users SET ${sets.join(', ')} WHERE guild_id = ? AND user_id = ?`)
      .run(...params, guildId, userId);
    return { ok: true, data: getNicoUser(guildId, 'userId' in patch ? patch.userId : userId) };
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    console.error('Error updating nico user:', error);
    return { ok: false, reason: 'error' };
  }
}

function removeNicoUser(guildId, userId) {
  const info = db.prepare('DELETE FROM nico_users WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  return info.changes > 0;
}

module.exports = {
  getNicoUserIds, getNicoUsersDetailed, getNicoUser, addNicoUser, updateNicoUser, removeNicoUser,
};
