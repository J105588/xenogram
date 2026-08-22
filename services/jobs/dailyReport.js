const { EmbedBuilder } = require('discord.js');
const niconico = require('../niconico');
const dbService = require('../database');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
const { markRun } = require('./status');

/**
 * 【毎朝7時に実行】各動画の前日比とグラフを含むレポート送信
 */
async function reportEachVideoStats() {
  console.log("Running daily reportEachVideoStats...");

  if (!config.DISCORD.CHANNEL_ID) {
    throw new Error("⚠️ DISCORD_CHANNEL_ID is not set in configuration!");
  }

  const videos = await dbService.getAllVideos();

  for (const video of videos) {
    try {
      const apiData = await niconico.fetchNicoData(video.id);
      if (!apiData) {
        console.warn(`⚠️ Skipping report for ${video.id}: Failed to fetch Niconico data.`);
        continue;
      }

      const latestDbStats = await dbService.getYesterdayStats(video.id);
      const diff = utils.calculateDiff(apiData, latestDbStats);

      // 新しい統計をDBに記録
      await dbService.recordStats(video.id, apiData.view, apiData.comment, apiData.mylist, apiData.like);

      // グラフURLの生成
      const history = await dbService.getStatsHistory(video.id);
      const chartUrl = utils.generateChartUrl(history);

      const embed = new EmbedBuilder()
        .setTitle(`Analytics: ${apiData.title}`)
        .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setThumbnail(apiData.thumbnail)
        .addFields(
          { name: "Views", value: `**${apiData.view.toLocaleString()}** (${utils.formatDiff(diff.view)})`, inline: true },
          { name: "Likes", value: `**${apiData.like.toLocaleString()}** (${utils.formatDiff(diff.like)})`, inline: true },
          { name: "Mylist", value: `**${apiData.mylist.toLocaleString()}** (${utils.formatDiff(diff.mylist)})`, inline: true },
          { name: "Comments", value: `**${apiData.comment.toLocaleString()}** (${utils.formatDiff(diff.comment)})`, inline: true },
          { name: "Tags", value: `\`${apiData.tags}\``, inline: false }
        )
        .setFooter({ text: config.FOOTER_TEXT })
        .setTimestamp();

      if (chartUrl) {
        embed.setImage(chartUrl);
      }

      await discordService.sendNotification(embed);
    } catch (itemError) {
      console.error(`❌ Failed to generate/send report for video ${video.id}:`, itemError);
      // 1本の動画で失敗しても、他の動画のレポート処理を止めずに次へ進む
    }
  }

  markRun('reportEachVideoStats');
}

module.exports = { reportEachVideoStats };
