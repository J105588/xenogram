const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../../../config');
const { fetchNicoData } = require('../../niconico');
const dbService = require('../../database');
const utils = require('../../../utils');

async function stats(interaction) {
  const videoId = interaction.options.getString('video_id');
  const apiData = await fetchNicoData(videoId);
  if (!apiData) return await interaction.editReply(`❌ 動画ID ${videoId} のデータが取得できませんでした。`);

  const latestDbStats = await dbService.getYesterdayStats(videoId);
  const diff = utils.calculateDiff(apiData, latestDbStats);
  const history = await dbService.getStatsHistory(videoId);

  // 最新データが「今日」のものでない場合のみ、現在のリアルタイム値をグラフの末尾に一時的に追加する
  const todayStr = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lastDateStr = history.length > 0
    ? new Date(history[history.length - 1].recorded_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : null;

  if (lastDateStr !== todayStr) {
    history.push({ views: apiData.view, recorded_at: new Date().toISOString() });
  }
  const chartUrl = utils.generateChartUrl(history);

  const embed = new EmbedBuilder()
    .setTitle(`Analytics: ${apiData.title}`)
    .setURL(`https://www.nicovideo.jp/watch/${videoId}`)
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setThumbnail(apiData.thumbnail)
    .addFields(
      { name: "Views", value: `**${apiData.view.toLocaleString()}** (${utils.formatDiff(diff.view)})`, inline: true },
      { name: "Likes", value: `**${apiData.like.toLocaleString()}** (${utils.formatDiff(diff.like)})`, inline: true },
      { name: "Mylist", value: `**${apiData.mylist.toLocaleString()}** (${utils.formatDiff(diff.mylist)})`, inline: true },
      { name: "Comments", value: `**${apiData.comment.toLocaleString()}** (${utils.formatDiff(diff.comment)})`, inline: true },
      { name: "Tags", value: `\`${apiData.tags}\``, inline: false }
    )
    .setFooter({ text: config.FOOTER_TEXT }).setTimestamp();

  if (chartUrl) embed.setImage(chartUrl);
  await interaction.editReply({ embeds: [embed] });
}

async function list(interaction) {
  const videos = await dbService.getAllVideos();
  if (!videos.length) return await interaction.editReply("現在監視中の動画はありません。");
  const embed = new EmbedBuilder().setTitle(`📺 監視中リスト (${videos.length}本)`).setColor(0x3498db);
  let desc = videos.map(v => `• [${v.id}](https://www.nicovideo.jp/watch/${v.id}) : ${v.title}`).join('\n');
  // Discordの文字数制限対策
  if (desc.length > 4000) desc = desc.slice(0, 3900) + "\n... (省略されました)";
  embed.setDescription(desc);
  await interaction.editReply({ embeds: [embed] });
}

async function add(interaction, { client }) {
  const videoId = interaction.options.getString('video_id');
  const exists = await dbService.hasVideo(videoId);
  if (exists) return await interaction.editReply(`⚠️ ${videoId} は既に監視リストに存在します。`);

  const apiData = await fetchNicoData(videoId);
  if (!apiData) return await interaction.editReply(`❌ 動画が見つかりませんでした。`);

  await dbService.addVideo(videoId, apiData.title, apiData.tags, apiData.thumbnail, apiData.publishedAt);
  await dbService.recordStats(videoId, apiData.view, apiData.comment, apiData.mylist, apiData.like);
  await interaction.editReply(`✅ **${apiData.title}** (${videoId}) を監視リストに追加しました！`);

  const videos = await dbService.getAllVideos();
  client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
}

async function remove(interaction, { client }) {
  const videoId = interaction.options.getString('video_id');
  const success = await dbService.removeVideo(videoId);
  if (success) {
    await interaction.editReply(`🗑️ ${videoId} を監視リストから削除しました。`);
    const videos = await dbService.getAllVideos();
    client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
  } else {
    await interaction.editReply(`❌ 削除に失敗しました。`);
  }
}

async function compare(interaction) {
  const v1 = interaction.options.getString('video_id1');
  const v2 = interaction.options.getString('video_id2');
  const [data1, data2] = await Promise.all([fetchNicoData(v1), fetchNicoData(v2)]);
  if (!data1 || !data2) return await interaction.editReply(`❌ 一部または両方の動画データが取得できませんでした。`);

  // 監視対象なら、直近24時間の伸び（DBの生履歴の中で最も古い記録との差分）も比較する
  const [growth1, growth2] = await Promise.all([
    dbService.getRecentStatsHistory(v1, 24),
    dbService.getRecentStatsHistory(v2, 24)
  ]);
  const diff24h = (current, history) => {
    if (!history.length) return null;
    const oldest = history[0];
    return {
      view: current.view - oldest.views,
      like: current.like - oldest.likes,
      spanHours: Math.max(1, Math.round((Date.now() - new Date(oldest.recorded_at).getTime()) / 3600000))
    };
  };
  const g1 = diff24h(data1, growth1);
  const g2 = diff24h(data2, growth2);

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ 動画比較`)
    .setColor(0x9b59b6)
    .addFields(
      {
        name: `A: ${data1.title} (${v1})`,
        value: `再生: ${data1.view.toLocaleString()}\nいいね: ${data1.like.toLocaleString()}\nマイリスト: ${data1.mylist.toLocaleString()}\nコメント: ${data1.comment.toLocaleString()}` +
          (g1 ? `\n直近${g1.spanHours}h伸び: 再生 ${utils.formatDiff(g1.view)} / いいね ${utils.formatDiff(g1.like)}` : '\n（監視外のため伸び率は算出不可）')
      },
      {
        name: `B: ${data2.title} (${v2})`,
        value: `再生: ${data2.view.toLocaleString()}\nいいね: ${data2.like.toLocaleString()}\nマイリスト: ${data2.mylist.toLocaleString()}\nコメント: ${data2.comment.toLocaleString()}` +
          (g2 ? `\n直近${g2.spanHours}h伸び: 再生 ${utils.formatDiff(g2.view)} / いいね ${utils.formatDiff(g2.like)}` : '\n（監視外のため伸び率は算出不可）')
      },
      {
        name: `🔥 累計差 (A - B)`,
        value: `再生差: **${(data1.view - data2.view).toLocaleString()}**\nいいね差: **${(data1.like - data2.like).toLocaleString()}**\nマイリスト差: **${(data1.mylist - data2.mylist).toLocaleString()}**\nコメント差: **${(data1.comment - data2.comment).toLocaleString()}**`
      }
    );

  if (g1 && g2) {
    const winner = g1.view === g2.view ? '互角' : (g1.view > g2.view ? 'A' : 'B');
    embed.addFields({
      name: `🚀 伸び率対決`,
      value: `再生の伸びが速いのは: **${winner}**（A: ${utils.formatDiff(g1.view)} / B: ${utils.formatDiff(g2.view)}）`
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function force_update(interaction) {
  await interaction.editReply("⏳ updateVideoList (1時間毎の処理) を実行中です...");
  const scheduler = require('../../scheduler');
  await scheduler.updateVideoList();
  await interaction.followUp("✅ 手動更新処理が完了しました。");
}

async function daily_report(interaction) {
  await interaction.editReply("⏳ デイリーレポートを実行し、通知チャンネルに送信しています...");
  const scheduler = require('../../scheduler');
  await scheduler.reportEachVideoStats();
  await interaction.followUp("✅ デイリーレポートの送信処理が完了しました。");
}

async function ranking(interaction) {
  const type = interaction.options.getString('type');
  const allStats = await dbService.getAllLatestStats();
  allStats.sort((a, b) => (b.stats[type] || 0) - (a.stats[type] || 0));
  const top10 = allStats.slice(0, 10);

  const embed = new EmbedBuilder().setTitle(`🏆 Ranking by ${type}`).setColor(0xf1c40f);
  let desc = top10.map((item, i) => `**${i + 1}位** [${item.video.title}](https://www.nicovideo.jp/watch/${item.video.id}) : ${item.stats[type].toLocaleString()}`).join('\n');
  embed.setDescription(desc || "データがありません");
  await interaction.editReply({ embeds: [embed] });
}

async function growth(interaction) {
  const videos = await dbService.getAllVideos();

  // パフォーマンス最適化: 非同期処理の並列化
  const growthPromises = videos.map(async (v) => {
    const history = await dbService.getStatsHistory(v.id, 2); // 最新2件
    if (history.length >= 2) {
      const diff = history[history.length - 1].views - history[history.length - 2].views;
      return { title: v.title, id: v.id, diff };
    }
    return null;
  });

  const allGrowths = await Promise.all(growthPromises);
  const growths = allGrowths.filter(g => g !== null);

  growths.sort((a, b) => b.diff - a.diff);
  const embed = new EmbedBuilder().setTitle(`🚀 Top Growth (Views)`).setColor(0x2ecc71);
  let desc = growths.slice(0, 5).map((g, i) => `**${i + 1}位** [${g.title}](https://www.nicovideo.jp/watch/${g.id}) : +${g.diff.toLocaleString()}再生`).join('\n');
  embed.setDescription(desc || "比較可能なデータがありません");
  await interaction.editReply({ embeds: [embed] });
}

async function upcoming(interaction) {
  const allStats = await dbService.getAllLatestStats();
  let upcomings = [];
  for (const item of allStats) {
    const upView = utils.getUpcomingMilestone(item.stats.views, 100);
    const upLike = utils.getUpcomingMilestone(item.stats.likes, 100);
    if (upView.remaining <= 20) {
      upcomings.push(`[${item.video.title}](https://www.nicovideo.jp/watch/${item.video.id}) - **${upView.nextMilestone}** 再生まであと **${upView.remaining}**！`);
    }
    if (upLike.remaining <= 10) {
      upcomings.push(`[${item.video.title}](https://www.nicovideo.jp/watch/${item.video.id}) - **${upLike.nextMilestone}** いいねまであと **${upLike.remaining}**！`);
    }
  }
  const embed = new EmbedBuilder().setTitle(`🎯 Upcoming Milestones`).setColor(0xe67e22);
  embed.setDescription(upcomings.length > 0 ? upcomings.join('\n') : "もうすぐキリ番の動画は現在ありません。");
  await interaction.editReply({ embeds: [embed] });
}

async function exportCsv(interaction) {
  const allStats = await dbService.getAllLatestStats();
  let csv = "ID,Title,Views,Likes,Mylists,Comments,LastUpdated\n";
  allStats.forEach(item => {
    csv += `${item.video.id},"${item.video.title.replace(/"/g, '""')}",${item.stats.views},${item.stats.likes},${item.stats.mylists},${item.stats.comments},${item.stats.recorded_at}\n`;
  });
  const fs = require('fs');
  fs.writeFileSync('./stats_export.csv', csv);
  const file = new AttachmentBuilder('./stats_export.csv');
  await interaction.editReply({ content: "📊 最新の統計データCSVです：", files: [file] });
}

module.exports = {
  stats, list, add, remove, compare,
  force_update, daily_report,
  ranking, growth, upcoming,
  export: exportCsv,
};
