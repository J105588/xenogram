const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { fetchNicoData } = require('../../niconico');
const dbService = require('../../database');
const utils = require('../../../utils');
const { buildVideoStatsEmbed } = require('../../reports/videoEmbed');

async function stats(interaction, { guildId }) {
  const videoId = interaction.options.getString('video_id');
  const apiData = await fetchNicoData(videoId);
  if (!apiData) return await interaction.editReply(`❌ 動画ID ${videoId} のデータが取得できませんでした。`);

  const previous = await dbService.getYesterdayStats(videoId);

  // 監視中の動画なら、デイリーレポートや毎時のupdateVideoListと同じようにこの手動確認時点の値もDBへ記録する。
  // こうしておくと手動チェックと自動レポートが同じ1本の履歴を積み上げるので、グラフに欠けが出ない
  // （監視外の動画はvideosテーブルに行が無くFK制約で書き込めないため対象外）。
  if (await dbService.hasVideo(guildId, videoId)) {
    await dbService.recordStats(videoId, apiData.view, apiData.comment, apiData.mylist, apiData.like);
  }

  // レポートと同じEmbedを使う（表示が2種類あると数字の読み方も2通りになってしまうため）
  const embed = buildVideoStatsEmbed({
    videoId,
    title: apiData.title,
    thumbnail: apiData.thumbnail,
    tags: apiData.tags,
    current: apiData,
    previous,
    history: await dbService.getStatsHistory(videoId, 7),
    diffHeader: 'vs 1d',
    titlePrefix: 'Analytics',
    milestoneStep: dbService.getSetting(guildId, 'milestone_step'),
  });

  await interaction.editReply({ embeds: [embed] });
}

async function list(interaction, { guildId }) {
  const videos = await dbService.getAllVideos(guildId);
  if (!videos.length) return await interaction.editReply("現在監視中の動画はありません。");
  const embed = new EmbedBuilder().setTitle(`📺 監視中リスト (${videos.length}本)`).setColor(0x3498db);
  let desc = videos.map(v => `• [${v.id}](https://www.nicovideo.jp/watch/${v.id}) : ${v.title}`).join('\n');
  // Discordの文字数制限対策
  if (desc.length > 4000) desc = desc.slice(0, 3900) + "\n... (省略されました)";
  embed.setDescription(desc);
  await interaction.editReply({ embeds: [embed] });
}

async function add(interaction, { client, guildId }) {
  const videoId = interaction.options.getString('video_id');
  const exists = await dbService.hasVideo(guildId, videoId);
  if (exists) return await interaction.editReply(`⚠️ ${videoId} は既に監視リストに存在します。`);

  const apiData = await fetchNicoData(videoId);
  if (!apiData) return await interaction.editReply(`❌ 動画が見つかりませんでした。`);

  await dbService.addVideo(guildId, videoId, apiData.title, apiData.tags, apiData.thumbnail, apiData.publishedAt);
  await dbService.recordStats(videoId, apiData.view, apiData.comment, apiData.mylist, apiData.like);
  // 過去のキリ番を遡って一斉通知しないよう、この鯖の通知基準値も現在値で初期化する
  await dbService.upsertNotifyState(guildId, videoId, {
    views: apiData.view, comments: apiData.comment, mylists: apiData.mylist, likes: apiData.like,
  });
  await interaction.editReply(`✅ **${apiData.title}** (${videoId}) を監視リストに追加しました！`);

  const watched = await dbService.getAllWatchedVideoIds();
  client.user.setActivity(`${watched.length}本の動画を監視中`, { type: 3 });
}

async function remove(interaction, { client, guildId }) {
  const videoId = interaction.options.getString('video_id');
  const success = await dbService.removeVideo(guildId, videoId);
  if (success) {
    await interaction.editReply(`🗑️ ${videoId} を監視リストから削除しました。`);
    const watched = await dbService.getAllWatchedVideoIds();
    client.user.setActivity(`${watched.length}本の動画を監視中`, { type: 3 });
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
        name: utils.truncate(`A: ${data1.title} (${v1})`, 256),
        value: `再生: ${data1.view.toLocaleString()}\nいいね: ${data1.like.toLocaleString()}\nマイリスト: ${data1.mylist.toLocaleString()}\nコメント: ${data1.comment.toLocaleString()}` +
          (g1 ? `\n直近${g1.spanHours}h伸び: 再生 ${utils.formatDiff(g1.view)} / いいね ${utils.formatDiff(g1.like)}` : '\n（監視外のため伸び率は算出不可）')
      },
      {
        name: utils.truncate(`B: ${data2.title} (${v2})`, 256),
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

async function force_update(interaction, { guildId }) {
  await interaction.editReply("⏳ updateVideoList (1時間毎の処理) を実行中です...");
  const scheduler = require('../../scheduler');
  const result = await scheduler.updateVideoList(guildId);

  const skipped = result && result.skipped;
  let message;
  if (skipped === 'already_running') {
    message = "⚠️ 前回の更新処理がまだ終わっていないため、今回はスキップしました。少し待ってからもう一度お試しください。";
  } else if (skipped === 'not_configured') {
    // 新規サーバーは完全に空の状態から始まるので、何を登録すれば動き出すかを示す
    const status = dbService.getGuildFeatureStatus(guildId);
    message = [
      'このサーバーではまだ監視対象が設定されていないため、何も実行されませんでした。',
      ...(status.notifyChannel ? [] : ['・通知先を決める: `/guild_setup channel:#チャンネル`']),
      '・投稿者を追う: `/user_add user_id:<数字>`',
      '・個別の動画を追う: `/add video_id:<sm...>`',
    ].join('\n');
  } else {
    message = "✅ 手動更新処理が完了しました。";
  }
  await interaction.followUp(message);
}

async function daily_report(interaction, { guildId }) {
  await interaction.editReply("⏳ デイリーレポートを実行し、通知チャンネルに送信しています...");
  const scheduler = require('../../scheduler');
  const result = await scheduler.reportEachVideoStats(guildId);
  await interaction.followUp(
    result && result.skipped === 'already_running'
      ? "⚠️ 前回のデイリーレポートがまだ終わっていないため、今回はスキップしました。少し待ってからもう一度お試しください。"
      : "✅ デイリーレポートの送信処理が完了しました。"
  );
}

async function ranking(interaction, { guildId }) {
  const type = interaction.options.getString('type');
  const allStats = await dbService.getAllLatestStats(guildId);
  allStats.sort((a, b) => (b.stats[type] || 0) - (a.stats[type] || 0));
  const top10 = allStats.slice(0, 10);

  const embed = new EmbedBuilder().setTitle(`🏆 Ranking by ${type}`).setColor(0xf1c40f);
  let desc = top10.map((item, i) => `**${i + 1}位** [${item.video.title}](https://www.nicovideo.jp/watch/${item.video.id}) : ${item.stats[type].toLocaleString()}`).join('\n');
  embed.setDescription(desc || "データがありません");
  await interaction.editReply({ embeds: [embed] });
}

async function growth(interaction, { guildId }) {
  const videos = await dbService.getAllVideos(guildId);

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

async function upcoming(interaction, { guildId }) {
  const allStats = await dbService.getAllLatestStats(guildId);
  const milestoneStep = dbService.getSetting(guildId, 'milestone_step');
  let upcomings = [];
  for (const item of allStats) {
    const upView = utils.getUpcomingMilestone(item.stats.views, milestoneStep);
    const upLike = utils.getUpcomingMilestone(item.stats.likes, milestoneStep);
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

async function exportCsv(interaction, { guildId }) {
  const allStats = await dbService.getAllLatestStats(guildId);
  let csv = "ID,Title,Views,Likes,Mylists,Comments,LastUpdated\n";
  allStats.forEach(item => {
    csv += `${item.video.id},"${item.video.title.replace(/"/g, '""')}",${item.stats.views},${item.stats.likes},${item.stats.mylists},${item.stats.comments},${item.stats.recorded_at}\n`;
  });
  // ディスクに書かず直接メモリ上のBufferから添付する
  // （固定パスへの書き込みだと、複数人が同時に /export した際にファイルが競合する）
  const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'stats_export.csv' });
  await interaction.editReply({ content: "📊 最新の統計データCSVです：", files: [file] });
}

// stats/remove/compare の video_id 系オプション共通のオートコンプリート。
// IDを手打ち・コピペせずに済むよう、ID・タイトルの部分一致で候補を出す。
async function autocompleteVideoId(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const videos = await dbService.getAllVideos(interaction.guildId);
  const choices = videos
    .filter((v) => v.id.toLowerCase().includes(focused) || (v.title || '').toLowerCase().includes(focused))
    .slice(0, 25)
    .map((v) => ({ name: `${v.id} - ${v.title}`.slice(0, 100), value: v.id }));
  await interaction.respond(choices);
}

module.exports = {
  stats, list, add, remove, compare,
  force_update, daily_report,
  ranking, growth, upcoming,
  export: exportCsv,
  autocompleteVideoId,
};
