const { EmbedBuilder } = require('discord.js');
const twitterApi = require('../twitterApi');
const dbService = require('../database');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
const { markRun } = require('./status');
const { withSingleFlight } = require('../singleFlight');

/**
 * 【毎時10分に実行・既定は無効】登録キーワードでXを検索し、新規ヒットを通知する。
 * 読み取り専用（検索APIしか呼ばない。投稿・返信等は一切行わない）。
 *
 * @param {object} [options]
 * @param {boolean} [options.bypassToggle] true なら /x_toggle off で無効化中でも実行する（/x_check 用）
 * @returns {Promise<{checked: number, hits: number, notified: number, skipped?: string}>}
 *   hits: 検索にヒットした件数（既に通知済みのツイートを含む）
 *   notified: そのうち未通知だった＝実際にDiscordへ送った件数
 */
async function runTwitterWatch(guildId, options = {}) {
  const outcome = await withSingleFlight(`twitterWatch:${guildId}`, () => runTwitterWatchInner(guildId, options));
  if (!outcome.ok) {
    console.warn("[X] 前回の実行がまだ完了していないため、今回はスキップします");
    return { checked: 0, hits: 0, notified: 0, skipped: 'already_running' };
  }
  return outcome.result;
}

async function runTwitterWatchInner(guildId, { bypassToggle = false } = {}) {
  console.log(`Running twitter (X) keyword watch... (guild: ${guildId})`);

  if (!config.TWITTER_MONITOR.ENABLED) {
    return { checked: 0, hits: 0, notified: 0, skipped: 'disabled_by_config' };
  }

  // 通知先が未設定なら検索しても届け先が無い（外部CLIの呼び出しが丸ごと無駄になる）
  if (!dbService.resolveChannelId(guildId, 'twitter')) {
    console.log(`[X] 通知先チャンネルが未設定のためスキップします (guild: ${guildId})`);
    return { checked: 0, hits: 0, notified: 0, skipped: 'no_channel' };
  }

  if (!bypassToggle) {
    const enabled = await dbService.getTwitterMonitorEnabled(guildId);
    if (!enabled) {
      console.log("[X] /x_toggle off により無効化されているため処理をスキップします");
      return { checked: 0, hits: 0, notified: 0, skipped: 'disabled' };
    }
  }

  const keywords = await dbService.getTwitterKeywords(guildId);
  if (!keywords.length) {
    console.log(`[X] 監視キーワードが未登録のため処理をスキップします (guild: ${guildId})`);
    return { checked: 0, hits: 0, notified: 0, skipped: 'no_keywords' };
  }

  if (!twitterApi.isConfigured()) {
    console.warn('[X] TWITTER_CT0 / TWITTER_AUTH_TOKEN が未設定です。.envの設定を確認してください。');
    return { checked: 0, hits: 0, notified: 0, skipped: 'cli_unavailable' };
  }

  let totalHits = 0;
  let totalNotified = 0;
  let failedKeywords = 0;
  let lastError = null;

  for (const keyword of keywords) {
    try {
      const tweets = await twitterApi.searchTweets(keyword.query, config.TWITTER_MONITOR.MAX_RESULTS);

      for (const tweet of tweets) {
        // 既に通知済みでも「検索にヒットした」事実としてカウントする
        // （/x_check で「本当に0件だったのか、既知のツイートしか無かったのか」を
        //  区別できるようにするため。ボカコレ側の hits/notified と同じ考え方）
        totalHits += 1;

        const already = await dbService.hasTwitterDetection(keyword.id, tweet.id);
        if (already) continue;

        const embed = new EmbedBuilder()
          .setTitle(`X: "${utils.truncate(keyword.query, 80)}" にヒット`)
          .setURL(tweet.url)
          .setColor(0x1d9bf0)
          .setDescription(utils.truncate(tweet.text || '(本文なし)', 2000))
          .addFields(
            { name: '投稿者', value: tweet.author ? `@${tweet.author}` : '不明', inline: true },
            { name: '検索キーワード', value: `\`${keyword.query}\``, inline: true }
          )
          .setFooter({ text: config.FOOTER_TEXT })
          .setTimestamp(tweet.createdAt ? new Date(tweet.createdAt) : new Date());

        const sent = await discordService.sendEmbedWithFiles({ guildId, kind: 'twitter', embed });
        if (sent) totalNotified += 1;

        await dbService.recordTwitterDetection({ keywordId: keyword.id, tweetId: tweet.id, author: tweet.author });
      }
    } catch (keywordError) {
      // 1キーワードの検索に失敗しても、他のキーワードのチェックは続行する。
      // ただし「ヒット0件」と区別が付かなくなるため、失敗件数として別カウントする
      // （X側のAPIエラー等で全滅していても、静かに「0件」に見えてしまう事故を防ぐ）。
      failedKeywords += 1;
      lastError = keywordError.message;
      console.error(`[X] キーワード "${keyword.query}" の検索に失敗しました:`, keywordError.message);
    }
  }

  console.log(`[X] ${keywords.length}件のキーワードを検索し、ヒット${totalHits}件・新規通知${totalNotified}件・失敗${failedKeywords}件`);
  markRun('twitterWatch');
  return { checked: keywords.length, hits: totalHits, notified: totalNotified, failedKeywords, lastError };
}

module.exports = { runTwitterWatch };
