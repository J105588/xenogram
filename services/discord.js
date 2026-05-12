const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const { fetchNicoData } = require('./niconico');
const supabaseService = require('./supabase');
const utils = require('../utils');
const fs = require('fs');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  { name: 'help', description: '利用可能な全コマンドのリストを表示します。' },
  { name: 'ping', description: 'Botの稼働状況と応答速度を確認します。' },
  { 
    name: 'stats', 
    description: '指定した動画の最新データとグラフを表示します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true }]
  },
  { name: 'list', description: '現在監視中の全動画のリストを表示します。' },
  { 
    name: 'add', 
    description: '手動で特定の動画を監視対象に追加します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true }]
  },
  { 
    name: 'remove', 
    description: '指定した動画を監視リストから除外します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true }]
  },
  { 
    name: 'compare', 
    description: '2つの動画のステータスを比較します。',
    options: [
      { name: 'video_id1', type: 3, description: '動画ID 1', required: true },
      { name: 'video_id2', type: 3, description: '動画ID 2', required: true }
    ]
  },
  { name: 'force_update', description: '【管理者】1時間に1回の定期更新を手動で実行します。' },
  { name: 'daily_report', description: '【管理者】毎朝のデイリーレポートを手動で実行します。' },
  { 
    name: 'ranking', 
    description: '監視中動画のランキングを表示します。',
    options: [{
      name: 'type', type: 3, description: 'ランキングの指標', required: true,
      choices: [
        { name: '再生数', value: 'views' },
        { name: 'いいね', value: 'likes' },
        { name: 'マイリスト', value: 'mylists' },
        { name: 'コメント', value: 'comments' }
      ]
    }]
  },
  { name: 'growth', description: '直近24時間で最も伸びている動画のトップを表示します。' },
  { name: 'upcoming', description: 'もうすぐ次のキリ番（マイルストーン）に到達しそうな動画を表示します。' },
  { name: 'export', description: '記録されている統計データをCSVファイルとしてエクスポートします。' }
];

async function registerCommands() {
  if (!config.DISCORD.TOKEN || !config.DISCORD.CLIENT_ID) return;
  const rest = new REST({ version: '10' }).setToken(config.DISCORD.TOKEN);
  try {
    console.log('Started refreshing application (/) commands.');
    if (config.DISCORD.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(config.DISCORD.CLIENT_ID, config.DISCORD.GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(config.DISCORD.CLIENT_ID), { body: commands });
    }
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  const videos = await supabaseService.getAllVideos();
  client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    await interaction.deferReply();

    if (commandName === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('📚 XENOGRAM Analytics Bot Commands')
        .setColor(parseInt(config.CHART_COLOR, 16));
      let desc = "";
      commands.forEach(cmd => { desc += `**\`/${cmd.name}\`** : ${cmd.description}\n`; });
      embed.setDescription(desc);
      await interaction.editReply({ embeds: [embed] });
    }
    
    else if (commandName === 'ping') {
      const ping = Date.now() - interaction.createdTimestamp;
      await interaction.editReply(`🏓 Pong! Latency is ${ping}ms. API Latency is ${Math.round(client.ws.ping)}ms`);
    }

    else if (commandName === 'stats') {
      const videoId = interaction.options.getString('video_id');
      const apiData = await fetchNicoData(videoId);
      if (!apiData) return await interaction.editReply(`❌ 動画ID ${videoId} のデータが取得できませんでした。`);

      const latestDbStats = await supabaseService.getYesterdayStats(videoId);
      const diff = utils.calculateDiff(apiData, latestDbStats);
      const history = await supabaseService.getStatsHistory(videoId);
      
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

    else if (commandName === 'list') {
      const videos = await supabaseService.getAllVideos();
      if (!videos.length) return await interaction.editReply("現在監視中の動画はありません。");
      const embed = new EmbedBuilder().setTitle(`📺 監視中リスト (${videos.length}本)`).setColor(0x3498db);
      let desc = videos.map(v => `• [${v.id}](https://www.nicovideo.jp/watch/${v.id}) : ${v.title}`).join('\n');
      // Discordの文字数制限対策
      if(desc.length > 4000) desc = desc.slice(0, 3900) + "\n... (省略されました)";
      embed.setDescription(desc);
      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'add') {
      const videoId = interaction.options.getString('video_id');
      const exists = await supabaseService.hasVideo(videoId);
      if (exists) return await interaction.editReply(`⚠️ ${videoId} は既に監視リストに存在します。`);
      
      const apiData = await fetchNicoData(videoId);
      if (!apiData) return await interaction.editReply(`❌ 動画が見つかりませんでした。`);
      
      await supabaseService.addVideo(videoId, apiData.title, apiData.tags, apiData.thumbnail, apiData.publishedAt);
      await supabaseService.recordStats(videoId, apiData.view, apiData.comment, apiData.mylist, apiData.like);
      await interaction.editReply(`✅ **${apiData.title}** (${videoId}) を監視リストに追加しました！`);
      
      const videos = await supabaseService.getAllVideos();
      client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
    }

    else if (commandName === 'remove') {
      const videoId = interaction.options.getString('video_id');
      const success = await supabaseService.removeVideo(videoId);
      if (success) {
        await interaction.editReply(`🗑️ ${videoId} を監視リストから削除しました。`);
        const videos = await supabaseService.getAllVideos();
        client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
      } else {
        await interaction.editReply(`❌ 削除に失敗しました。`);
      }
    }

    else if (commandName === 'compare') {
      const v1 = interaction.options.getString('video_id1');
      const v2 = interaction.options.getString('video_id2');
      const data1 = await fetchNicoData(v1);
      const data2 = await fetchNicoData(v2);
      if (!data1 || !data2) return await interaction.editReply(`❌ 一部または両方の動画データが取得できませんでした。`);

      const embed = new EmbedBuilder()
        .setTitle(`⚔️ 動画比較`)
        .setColor(0x9b59b6)
        .addFields(
          { name: `A: ${data1.title} (${v1})`, value: `再生: ${data1.view.toLocaleString()}\nいいね: ${data1.like.toLocaleString()}` },
          { name: `B: ${data2.title} (${v2})`, value: `再生: ${data2.view.toLocaleString()}\nいいね: ${data2.like.toLocaleString()}` },
          { name: `🔥 結果 (A - B)`, value: `再生差: **${(data1.view - data2.view).toLocaleString()}**\nいいね差: **${(data1.like - data2.like).toLocaleString()}**` }
        );
      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'force_update') {
      await interaction.editReply("⏳ updateVideoList (1時間毎の処理) を実行中です...");
      const scheduler = require('./scheduler');
      await scheduler.updateVideoList();
      await interaction.followUp("✅ 手動更新処理が完了しました。");
    }

    else if (commandName === 'daily_report') {
      await interaction.editReply("⏳ デイリーレポートを実行し、通知チャンネルに送信しています...");
      const scheduler = require('./scheduler');
      await scheduler.reportEachVideoStats();
      await interaction.followUp("✅ デイリーレポートの送信処理が完了しました。");
    }

    else if (commandName === 'ranking') {
      const type = interaction.options.getString('type');
      const allStats = await supabaseService.getAllLatestStats();
      allStats.sort((a, b) => (b.stats[type] || 0) - (a.stats[type] || 0));
      const top10 = allStats.slice(0, 10);

      const embed = new EmbedBuilder().setTitle(`🏆 Ranking by ${type}`).setColor(0xf1c40f);
      let desc = top10.map((item, i) => `**${i+1}位** [${item.video.title}](https://www.nicovideo.jp/watch/${item.video.id}) : ${item.stats[type].toLocaleString()}`).join('\n');
      embed.setDescription(desc || "データがありません");
      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'growth') {
      const videos = await supabaseService.getAllVideos();
      
      // パフォーマンス最適化: 非同期処理の並列化
      const growthPromises = videos.map(async (v) => {
        const history = await supabaseService.getStatsHistory(v.id, 2); // 最新2件
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
      let desc = growths.slice(0, 5).map((g, i) => `**${i+1}位** [${g.title}](https://www.nicovideo.jp/watch/${g.id}) : +${g.diff.toLocaleString()}再生`).join('\n');
      embed.setDescription(desc || "比較可能なデータがありません");
      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'upcoming') {
      const allStats = await supabaseService.getAllLatestStats();
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

    else if (commandName === 'export') {
      const allStats = await supabaseService.getAllLatestStats();
      let csv = "ID,Title,Views,Likes,Mylists,Comments,LastUpdated\n";
      allStats.forEach(item => {
        csv += `${item.video.id},"${item.video.title.replace(/"/g, '""')}",${item.stats.views},${item.stats.likes},${item.stats.mylists},${item.stats.comments},${item.stats.recorded_at}\n`;
      });
      fs.writeFileSync('./stats_export.csv', csv);
      const file = new AttachmentBuilder('./stats_export.csv');
      await interaction.editReply({ content: "📊 最新の統計データCSVです：", files: [file] });
    }

    } catch (err) {
    console.error("Command Error:", err);
    
    // エラー通知チャンネルにも詳細を送信する（追加）
    await sendErrorEmbed(err, `🚨 Command Execution Error (/${commandName})`);

    try {
      const errorMessage = "❌ コマンドの実行中にエラーが発生しました。詳細なログを確認してください。";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (followUpError) {
      console.error("Failed to send error message to user:", followUpError);
    }
  }
});

async function sendNotification(embedOrText) {
  if (!config.DISCORD.CHANNEL_ID) {
    console.error("❌ [CRITICAL] DISCORD_CHANNEL_ID is missing in config. Cannot send notification.");
    return false;
  }
  try {
    const channel = await client.channels.fetch(config.DISCORD.CHANNEL_ID);
    if (!channel) {
      console.error(`❌ [ERROR] Channel not found for ID: ${config.DISCORD.CHANNEL_ID}`);
      return false;
    }
    if (typeof embedOrText === 'string') await channel.send(embedOrText);
    else await channel.send({ embeds: [embedOrText] });
    return true;
  } catch (error) {
    console.error("❌ [ERROR] Error sending notification to Discord:", error);
    return false;
  }
}

async function sendErrorEmbed(error, title = "🚨 Runtime Error") {
  const errorMessage = error.stack || error.message || String(error);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xff0000)
    .setDescription(`\`\`\`js\n${errorMessage.slice(0, 3900)}\n\`\`\``)
    .setTimestamp();
  
  await sendNotification(embed);
}

function startDiscordBot() {
  if (!config.DISCORD.TOKEN) {
    console.error("❌ [CRITICAL] DISCORD_TOKEN is missing! The bot CANNOT log in and will remain offline.");
    return;
  }
  client.login(config.DISCORD.TOKEN).catch(err => {
    console.error("❌ [CRITICAL] Failed to login to Discord. Is the token correct?", err);
  });
}

module.exports = { client, startDiscordBot, sendNotification, sendErrorEmbed };
