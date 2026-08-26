const { db } = require('./db');

/* =====================================================================
 * サーバー（ギルド）登録と、鯖ごとの通知先チャンネル。
 *
 * 通知先が未設定の鯖には通知を送らない。Botを入れただけで意図しない
 * チャンネルに流れ出すのを防ぐため、/guild_setup での明示的な指定を必須にする。
 * ===================================================================== */

const CHANNEL_COLUMNS = {
  notify: 'notify_channel_id',
  video: 'video_channel_id',
  vocacolle: 'vocacolle_channel_id',
  twitter: 'twitter_channel_id',
};

function getGuild(guildId) {
  const row = db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId);
  return row || null;
}

/**
 * 登録済みの全サーバー。定期ジョブはこの一覧を回して鯖ごとに処理する。
 */
function getAllGuilds() {
  return db.prepare('SELECT * FROM guilds ORDER BY added_at ASC').all();
}

/**
 * 通知先が設定済みのサーバーだけを返す（実際に通知を送る対象）。
 */
function getActiveGuilds() {
  return db.prepare(`
    SELECT * FROM guilds
    WHERE notify_channel_id IS NOT NULL AND notify_channel_id <> ''
    ORDER BY added_at ASC
  `).all();
}

/**
 * サーバーを登録する（無ければ作る）。Botの参加時と各コマンドの実行時に呼ぶ。
 * 既存行のチャンネル設定は上書きしない（名前だけ最新に追従させる）。
 */
function ensureGuild(guildId, name = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO guilds (guild_id, name, added_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      name = COALESCE(excluded.name, guilds.name),
      updated_at = excluded.updated_at
  `).run(guildId, name, now, now);
  return getGuild(guildId);
}

/**
 * 通知先チャンネルを設定する。
 * @param {string} guildId
 * @param {'notify'|'video'|'vocacolle'|'twitter'} kind
 * @param {string|null} channelId null を渡すと解除（＝その通知を止める）
 */
function setGuildChannel(guildId, kind, channelId) {
  const column = CHANNEL_COLUMNS[kind];
  if (!column) return { ok: false, reason: 'unknown_kind' };

  ensureGuild(guildId);
  db.prepare(`UPDATE guilds SET ${column} = ?, updated_at = ? WHERE guild_id = ?`)
    .run(channelId, new Date().toISOString(), guildId);
  return { ok: true, data: getGuild(guildId) };
}

/**
 * 用途別の送信先チャンネルIDを解決する。
 * 動画監視・ボカコレ・Xの専用チャンネルが未設定なら通常の通知チャンネルに落とす
 * （用途ごとに分けたい鯖だけが設定すればよい形にするため）。
 */
function resolveChannelId(guildId, kind = 'notify') {
  const guild = getGuild(guildId);
  if (!guild) return null;
  return guild[CHANNEL_COLUMNS[kind]] || guild.notify_channel_id || null;
}

/**
 * 引き継ぎ先が決まらないまま 'legacy' に退避された既存データを、
 * このサーバーの所有に付け替える（DISCORD_GUILD_ID 未設定で起動した場合の救済）。
 */
function adoptLegacyData(guildId) {
  const legacy = getGuild('legacy');
  if (!legacy) return { ok: false, reason: 'no_legacy_data' };
  if (guildId === 'legacy') return { ok: false, reason: 'invalid_target' };

  ensureGuild(guildId);
  const moved = {};
  const tables = ['guild_videos', 'guild_video_notify_state', 'vocacolle_keywords', 'twitter_keywords', 'nico_users', 'app_settings'];

  for (const table of tables) {
    // 移動先に同じ主キーの行が既にある場合は移せないので、衝突しないものだけ動かす
    const info = db.prepare(`UPDATE OR IGNORE ${table} SET guild_id = ? WHERE guild_id = 'legacy'`).run(guildId);
    moved[table] = info.changes;
  }

  db.prepare(`
    UPDATE guilds SET
      notify_channel_id    = COALESCE(notify_channel_id, ?),
      video_channel_id     = COALESCE(video_channel_id, ?),
      vocacolle_channel_id = COALESCE(vocacolle_channel_id, ?),
      twitter_channel_id   = COALESCE(twitter_channel_id, ?),
      updated_at = ?
    WHERE guild_id = ?
  `).run(legacy.notify_channel_id, legacy.video_channel_id, legacy.vocacolle_channel_id, legacy.twitter_channel_id, new Date().toISOString(), guildId);

  db.prepare("DELETE FROM guilds WHERE guild_id = 'legacy'").run();
  return { ok: true, moved };
}

/**
 * その鯖で各機能が「実際に動く状態か」を返す。
 *
 * Botを新しいサーバーに入れた直後は何も登録されていないので、
 * どの機能も動かないのが正しい。「有効/無効のトグル」だけを見て
 * 有効と表示してしまうと、実際には何も起きないのに動いているように見えるため、
 * 登録件数と通知先の有無まで含めた「実効状態」をここで1か所にまとめる。
 *
 * @returns {{configured: boolean, notifyChannel: string|null, video: object, vocacolle: object, twitter: object}}
 */
function getGuildFeatureStatus(guildId) {
  const count = (sql) => db.prepare(sql).get(guildId).c;

  const notifyChannel = resolveChannelId(guildId, 'notify');
  const videoChannel = resolveChannelId(guildId, 'video');
  const vocaChannel = resolveChannelId(guildId, 'vocacolle');
  const xChannel = resolveChannelId(guildId, 'twitter');
  const userCount = count('SELECT COUNT(*) c FROM nico_users WHERE guild_id = ?');
  const videoCount = count('SELECT COUNT(*) c FROM guild_videos WHERE guild_id = ?');
  const vocaCount = count('SELECT COUNT(*) c FROM vocacolle_keywords WHERE guild_id = ? AND enabled = 1');
  const xCount = count('SELECT COUNT(*) c FROM twitter_keywords WHERE guild_id = ? AND enabled = 1');

  const toggle = (key, fallback = true) => {
    const row = db.prepare('SELECT value FROM app_settings WHERE guild_id = ? AND key = ?').get(guildId, key);
    return row ? row.value === '1' : fallback;
  };

  const vocaEnabled = toggle('vocacolle_watch_enabled');
  const xEnabled = toggle('twitter_monitor_enabled');

  return {
    notifyChannel,
    // 通知先すら決まっていない＝まだセットアップされていないサーバー
    configured: !!notifyChannel,
    video: {
      channel: videoChannel,
      users: userCount,
      videos: videoCount,
      // 監視対象ユーザーも個別登録動画も無ければ、追う相手がいない
      active: !!videoChannel && (userCount > 0 || videoCount > 0),
    },
    vocacolle: {
      channel: vocaChannel,
      keywords: vocaCount,
      enabled: vocaEnabled,
      active: !!vocaChannel && vocaEnabled && vocaCount > 0,
    },
    twitter: {
      channel: xChannel,
      keywords: xCount,
      enabled: xEnabled,
      active: !!xChannel && xEnabled && xCount > 0,
    },
  };
}

module.exports = {
  getGuild,
  getAllGuilds,
  getActiveGuilds,
  ensureGuild,
  setGuildChannel,
  resolveChannelId,
  adoptLegacyData,
  getGuildFeatureStatus,
};
