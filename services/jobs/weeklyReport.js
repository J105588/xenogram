const dbService = require('../database');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
const { buildVideoStatsEmbed, buildSummaryEmbed } = require('../reports/videoEmbed');
const { markRun } = require('./status');
const { withSingleFlight } = require('../singleFlight');

/**
 * 【毎週日曜21時に実行】週の総括レポート。
 *
 * 日次レポートは「前日比」だが、こちらは「7日前比」で1週間分の伸びを見る。
 * video_stats が毎時1行の履歴になったことで、7日分のグラフも意味のある
 * 粒度で描けるようになったため追加した。
 * 手動実行と自動実行が重なっても二重送信されないよう、常に1本だけ走らせる。
 */
async function sendWeeklyReport(guildId) {
  const outcome = await withSingleFlight(`weeklyReport:${guildId}`, () => sendWeeklyReportInner(guildId));
  if (!outcome.ok) {
    console.warn(`[WEEKLY] 前回の週次レポートがまだ完了していないため、今回はスキップします (guild: ${guildId})`);
    return { skipped: 'already_running' };
  }
  return outcome.result;
}

async function sendWeeklyReportInner(guildId) {
  console.log(`Running weekly report... (guild: ${guildId})`);

  if (!dbService.resolveChannelId(guildId, 'notify')) {
    console.warn(`週次レポート: 通知先チャンネルが未設定のためスキップします (guild: ${guildId})`);
    return { skipped: 'no_channel' };
  }

  const videos = await dbService.getAllVideos(guildId);
  if (!videos.length) {
    console.log(`週次レポート: 監視中の動画がないためスキップします (guild: ${guildId})`);
    markRun('weeklyReport');
    return;
  }

  const rows = [];

  for (const video of videos) {
    try {
      const [latest, weekAgo, history] = await Promise.all([
        dbService.getLatestStats(video.id),
        dbService.getStatsAsOf(video.id, 7),
        dbService.getStatsHistory(video.id, 7),
      ]);
      if (!latest) continue;

      // 日次レポートと同じ計算・同じ表示に通せるよう、DBの行をAPIと同じ形に揃える
      const current = utils.fromStatsRow(latest);
      rows.push({
        video,
        current,
        previous: weekAgo,
        diff: utils.calculateDiff(current, weekAgo),
        history,
        trend: utils.analyzeHistory(history, 'views'),
      });
    } catch (itemError) {
      console.error(`❌ Failed to build weekly stats for ${video.id}:`, itemError);
    }
  }

  if (!rows.length) {
    console.log("週次レポート: 有効な統計データがないためスキップします");
    markRun('weeklyReport');
    return;
  }

  // 全体サマリー（今週いちばん伸びた動画がひと目で分かるように）
  try {
    await discordService.sendNotification(
      guildId,
      buildSummaryEmbed(rows, { title: '週次まとめレポート', periodLabel: '今週' })
    );
  } catch (summaryError) {
    console.error('❌ Failed to send weekly summary embed:', summaryError);
  }

  const milestoneStep = dbService.getSetting(guildId, 'milestone_step');

  // 動画ごとの詳細（日次レポートと同じ形式で、7日間比較版）
  for (const row of rows) {
    try {
      const embed = buildVideoStatsEmbed({
        videoId: row.video.id,
        title: row.video.title,
        thumbnail: row.video.thumbnail_url,
        tags: row.video.tags,
        current: row.current,
        previous: row.previous,
        history: row.history,
        diffHeader: 'vs 7d',
        titlePrefix: '週報',
        milestoneStep,
      });
      await discordService.sendNotification(guildId, embed);
    } catch (itemError) {
      console.error(`❌ Failed to send weekly report for ${row.video.id}:`, itemError);
    }
  }

  markRun('weeklyReport');
}

module.exports = { sendWeeklyReport };
