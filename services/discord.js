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
  { name: 'export', description: '記録されている統計データをCSVファイルとしてエクスポートします。' },
  {
    name: 'vc_add',
    description: 'ボカコレ監視キーワードを追加します（曲名・アーティスト名の完全一致）。',
    options: [
      { name: 'keyword', type: 3, description: '完全一致させる曲名またはアーティスト名', required: true },
      {
        name: 'target', type: 3, description: '照合する対象', required: true,
        choices: [
          { name: '曲名', value: 'title' },
          { name: 'アーティスト名', value: 'artist' }
        ]
      },
      { name: 'active_from', type: 3, description: '監視開始日時 (例: 2026-08-21 19:00)', required: false },
      { name: 'active_until', type: 3, description: '監視終了日時 (例: 2026-08-24 17:00)', required: false },
      { name: 'note', type: 3, description: 'メモ', required: false }
    ]
  },
  { name: 'vc_list', description: 'ボカコレ監視キーワードの一覧を表示します。' },
  {
    name: 'vc_remove',
    description: 'ボカコレ監視キーワードを削除します。',
    options: [{ name: 'id', type: 4, description: '/vc_list で表示されるID', required: true }]
  },
  { name: 'vc_check', description: '【管理者】ボカコレ監視を今すぐ1回実行します。' },
  {
    name: 'vc_toggle',
    description: '【管理者】ボカコレ監視の有効/無効を切り替えます（再起動不要）。',
    options: [{
      name: 'state', type: 3, description: '設定する状態', required: true,
      choices: [
        { name: '有効にする (ON)', value: 'on' },
        { name: '無効にする (OFF)', value: 'off' }
      ]
    }]
  }
];

/**
 * "2026-08-21 19:00" のような入力を JST として ISO 文字列に変換する。
 * ISO 形式で渡された場合はそのまま解釈する。
 * @returns {string|null} 変換できなければ null
 */
function parseJstDateTime(input) {
  if (!input) return null;

  const trimmed = input.trim();
  // 既にタイムゾーン付きならそのまま解釈する
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const m = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;

  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  // JST(+09:00) 固定で組み立てる
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(sec)}+09:00`;
  const parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * ISO 文字列を日本時間の見やすい表記にする
 */
function formatJst(iso) {
  if (!iso) return '制限なし';
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

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

    else if (commandName === 'vc_add') {
      const keyword = interaction.options.getString('keyword');
      const target = interaction.options.getString('target');
      const fromRaw = interaction.options.getString('active_from');
      const untilRaw = interaction.options.getString('active_until');
      const note = interaction.options.getString('note');

      const activeFrom = parseJstDateTime(fromRaw);
      const activeUntil = parseJstDateTime(untilRaw);

      if (fromRaw && !activeFrom) {
        return await interaction.editReply(`日時の形式が読み取れませんでした: \`${fromRaw}\`（例: 2026-08-21 19:00）`);
      }
      if (untilRaw && !activeUntil) {
        return await interaction.editReply(`日時の形式が読み取れませんでした: \`${untilRaw}\`（例: 2026-08-24 17:00）`);
      }
      if (activeFrom && activeUntil && new Date(activeFrom) >= new Date(activeUntil)) {
        return await interaction.editReply("監視終了日時は開始日時より後に設定してください。");
      }

      const { data, error } = await supabaseService.addVocacolleKeyword({
        keyword, target, activeFrom, activeUntil, note
      });

      if (error) {
        const duplicated = error.code === '23505';
        return await interaction.editReply(
          duplicated
            ? `\`${keyword}\` は既に同じ対象で登録されています。`
            : "キーワードの登録に失敗しました。ログを確認してください。"
        );
      }

      const targetLabel = target === 'artist' ? 'アーティスト名' : '曲名';
      const embed = new EmbedBuilder()
        .setTitle('ボカコレ監視キーワードを追加しました')
        .setColor(parseInt(config.CHART_COLOR, 16))
        .addFields(
          { name: "ID", value: String(data.id), inline: true },
          { name: "対象", value: targetLabel, inline: true },
          { name: "キーワード", value: `\`${data.keyword}\``, inline: false },
          { name: "監視開始", value: formatJst(data.active_from), inline: true },
          { name: "監視終了", value: formatJst(data.active_until), inline: true }
        )
        .setFooter({ text: config.FOOTER_TEXT });

      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'vc_list') {
      const [keywords, watchEnabled] = await Promise.all([
        supabaseService.getVocacolleKeywords(true),
        supabaseService.getVocacolleWatchEnabled()
      ]);
      const watchStateLine = `監視スケジュール: ${watchEnabled ? '**有効** (毎時5分に実行)' : '**無効** (/vc_toggle on で再開)'}`;

      if (!keywords.length) {
        return await interaction.editReply(`${watchStateLine}\n監視キーワードは登録されていません。`);
      }

      const vocacolle = require('./vocacolle');
      const now = new Date();

      const lines = keywords.map(k => {
        const targetLabel = k.target === 'artist' ? 'アーティスト' : '曲名';
        const state = vocacolle.isActive(k, now) ? '有効' : '期間外/停止中';
        const period = (k.active_from || k.active_until)
          ? `${formatJst(k.active_from)} 〜 ${formatJst(k.active_until)}`
          : '常時';
        return `**#${k.id}** [${targetLabel}] \`${k.keyword}\`\n　${state} / ${period}`;
      });

      let desc = `${watchStateLine}\n\n${lines.join('\n')}`;
      if (desc.length > 4000) desc = desc.slice(0, 3900) + "\n... (省略されました)";

      const embed = new EmbedBuilder()
        .setTitle(`ボカコレ監視キーワード (${keywords.length}件)`)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setDescription(desc)
        .setFooter({ text: config.FOOTER_TEXT });

      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'vc_remove') {
      const id = interaction.options.getInteger('id');
      const success = await supabaseService.removeVocacolleKeyword(id);
      await interaction.editReply(success ? `監視キーワード #${id} を削除しました。` : "削除に失敗しました。");
    }

    else if (commandName === 'vc_check') {
      await interaction.editReply("ボカコレランキングを確認しています...（/vc_toggle off 中でも実行します）");
      const scheduler = require('./scheduler');
      // notifySummary: true にして、新規ヒットが無い場合でも定期実行と同じ
      // スクショ付きサマリーがチャンネルに届くようにする（手動確認の見た目を統一）
      const result = await scheduler.runVocacolleWatch({ bypassToggle: true, notifySummary: true, summaryScreenshot: true });
      if (result.skipped === 'no_keywords') {
        await interaction.followUp("監視キーワードが1件も登録されていません。/vc_add で登録してください。");
      } else {
        await interaction.followUp(
          `確認完了: ${result.checked}件を照合し、ヒット ${result.hits}件 / 新規通知 ${result.notified}件でした。`
        );
      }
    }

    else if (commandName === 'vc_toggle') {
      const state = interaction.options.getString('state');
      const enabled = state === 'on';
      const success = await supabaseService.setVocacolleWatchEnabled(enabled);

      if (!success) {
        return await interaction.editReply("設定の更新に失敗しました。ログを確認してください。");
      }

      await interaction.editReply(
        enabled
          ? `ボカコレ監視を **有効** にしました。次回は毎時5分（JST）に実行されます。`
          : `ボカコレ監視を **無効** にしました。毎時のチェックはスキップされます（/vc_check は引き続き手動実行できます）。`
      );
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

/**
 * 任意のチャンネルへ Embed（複数可）と添付ファイルを送る（ボカコレ通知用）
 * @param {object} params
 * @param {string} params.channelId 送信先チャンネルID
 * @param {EmbedBuilder} [params.embed] 単一のEmbedを送る場合
 * @param {EmbedBuilder[]} [params.embeds] 複数のEmbedを1メッセージにまとめて送る場合
 * @param {Array<{buffer: Buffer, name: string}>} [params.files] 添付ファイル（各Embedから attachment://ファイル名 で参照できる）
 */
async function sendEmbedWithFiles({ channelId, embed, embeds, files = [] }) {
  const targetId = channelId || config.DISCORD.CHANNEL_ID;
  if (!targetId) {
    console.error("[ERROR] 送信先チャンネルIDが設定されていません。");
    return false;
  }

  const embedList = embeds || (embed ? [embed] : []);
  if (!embedList.length) {
    console.error("[ERROR] 送信するEmbedがありません。");
    return false;
  }

  try {
    const channel = await client.channels.fetch(targetId);
    if (!channel) {
      console.error(`[ERROR] Channel not found for ID: ${targetId}`);
      return false;
    }

    const attachments = files.map(f => new AttachmentBuilder(f.buffer, { name: f.name }));
    await channel.send({ embeds: embedList, files: attachments });
    return true;
  } catch (error) {
    console.error("[ERROR] Failed to send embed with files:", error);
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

module.exports = { client, startDiscordBot, sendNotification, sendEmbedWithFiles, sendErrorEmbed };
