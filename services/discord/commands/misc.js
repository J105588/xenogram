const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const supabaseService = require('../../supabase');
const { commands } = require('../definitions');
const { formatJst } = require('../format');

async function help(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📚 XENOGRAM Analytics Bot Commands')
    .setColor(parseInt(config.CHART_COLOR, 16));
  let desc = "";
  commands.forEach(cmd => { desc += `**\`/${cmd.name}\`** : ${cmd.description}\n`; });
  embed.setDescription(desc);
  await interaction.editReply({ embeds: [embed] });
}

async function ping(interaction, { client }) {
  const ping = Date.now() - interaction.createdTimestamp;
  await interaction.editReply(`🏓 Pong! Latency is ${ping}ms. API Latency is ${Math.round(client.ws.ping)}ms`);
}

async function status(interaction) {
  const os = require('os');
  const scheduler = require('../../scheduler');

  const [videos, keywords, watchEnabled] = await Promise.all([
    supabaseService.getAllVideos(),
    supabaseService.getVocacolleKeywords(),
    supabaseService.getVocacolleWatchEnabled()
  ]);

  const lastRun = scheduler.getSchedulerStatus();
  const formatLastRun = (iso) => (iso ? formatJst(iso) : '（再起動後まだ未実行）');

  const mem = process.memoryUsage();
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  const embed = new EmbedBuilder()
    .setTitle('🖥️ Bot稼働状況')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .addFields(
      { name: 'ホスト', value: os.hostname(), inline: true },
      { name: '起動時間', value: `${h}時間${m}分${s}秒`, inline: true },
      { name: 'メモリ (RSS)', value: `${Math.round(mem.rss / 1024 / 1024)}MB`, inline: true },
      { name: '監視動画数', value: `${videos.length}本`, inline: true },
      { name: 'ボカコレキーワード', value: `${keywords.length}件`, inline: true },
      { name: 'ボカコレ監視', value: watchEnabled ? '有効' : '無効', inline: true },
      { name: '毎時 新着/キリ番チェック 最終実行', value: formatLastRun(lastRun.updateVideoList), inline: false },
      { name: '毎朝 デイリーレポート 最終実行', value: formatLastRun(lastRun.reportEachVideoStats), inline: false },
      { name: 'ボカコレ監視 最終実行', value: formatLastRun(lastRun.vocacolleWatch), inline: false },
      { name: '週次レポート 最終実行', value: formatLastRun(lastRun.weeklyReport), inline: false }
    )
    .setFooter({ text: config.FOOTER_TEXT })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { help, ping, status };
