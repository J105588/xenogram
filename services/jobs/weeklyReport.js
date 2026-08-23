const { EmbedBuilder } = require('discord.js');
const dbService = require('../database');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
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
async function sendWeeklyReport() {
  const outcome = await withSingleFlight('weeklyReport', sendWeeklyReportInner);
  if (!outcome.ok) {
    console.warn("[WEEKLY] 前回の週次レポートがまだ完了していないため、今回はスキップします");
    return { skipped: 'already_running' };
  }
  return outcome.result;
}

async function sendWeeklyReportInner() {
  console.log("Running weekly report...");

  if (!config.DISCORD.CHANNEL_ID) {
    throw new Error("⚠️ DISCORD_CHANNEL_ID is not set in configuration!");
  }

  const videos = await dbService.getAllVideos();
  if (!videos.length) {
    console.log("週次レポート: 監視中の動画がないためスキップします");
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

      const diff = {
        view: latest.views - (weekAgo ? weekAgo.views : 0),
        like: latest.likes - (weekAgo ? weekAgo.likes : 0),
        mylist: latest.mylists - (weekAgo ? weekAgo.mylists : 0),
        comment: latest.comments - (weekAgo ? weekAgo.comments : 0),
      };

      rows.push({ video, latest, diff, history });
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
  const totalViewGrowth = rows.reduce((sum, r) => sum + r.diff.view, 0);
  const ranked = [...rows].sort((a, b) => b.diff.view - a.diff.view);

  const summaryEmbed = new EmbedBuilder()
    .setTitle('📅 週次まとめレポート')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(`監視中 ${rows.length}本 / 今週の合計再生増加: **${totalViewGrowth.toLocaleString()}**`)
    .addFields(
      ranked.slice(0, 5).map((r, i) => ({
        name: utils.truncate(`${i + 1}位 ${r.video.title}`, 256),
        value: `再生 ${utils.formatDiff(r.diff.view)}・いいね ${utils.formatDiff(r.diff.like)}`,
        inline: false,
      }))
    )
    .setFooter({ text: config.FOOTER_TEXT })
    .setTimestamp();

  await discordService.sendNotification(summaryEmbed);

  // 動画ごとの詳細（日次レポートと同じ形式で、7日間比較版）
  for (const { video, latest, diff, history } of rows) {
    try {
      const chartUrl = utils.generateChartUrl(history);

      const embed = new EmbedBuilder()
        .setTitle(utils.truncate(`週報: ${video.title}`, 256))
        .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setThumbnail(video.thumbnail_url)
        .addFields(
          { name: "Views", value: `**${latest.views.toLocaleString()}** (${utils.formatDiff(diff.view)}/週)`, inline: true },
          { name: "Likes", value: `**${latest.likes.toLocaleString()}** (${utils.formatDiff(diff.like)}/週)`, inline: true },
          { name: "Mylist", value: `**${latest.mylists.toLocaleString()}** (${utils.formatDiff(diff.mylist)}/週)`, inline: true },
          { name: "Comments", value: `**${latest.comments.toLocaleString()}** (${utils.formatDiff(diff.comment)}/週)`, inline: true },
        )
        .setFooter({ text: config.FOOTER_TEXT })
        .setTimestamp();

      if (chartUrl) embed.setImage(chartUrl);

      await discordService.sendNotification(embed);
    } catch (itemError) {
      console.error(`❌ Failed to send weekly report for ${video.id}:`, itemError);
    }
  }

  markRun('weeklyReport');
}

module.exports = { sendWeeklyReport };
