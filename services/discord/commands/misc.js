const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');
const { commands } = require('../definitions');
const { formatJst } = require('../format');

// コマンド名の接頭辞でカテゴリ分けして表示する（27個を並べるだけだと探しにくいため）
const CATEGORIES = [
  { label: '📺 動画の監視', match: (n) => ['stats', 'list', 'add', 'remove', 'compare', 'ranking', 'growth', 'upcoming', 'export'].includes(n) },
  { label: '🎯 ボカコレ/ランキング監視', match: (n) => n.startsWith('vc_') },
  { label: '📡 監視対象ユーザー（複数のニコニコアカウントを追う）', match: (n) => n.startsWith('user_') },
  { label: '⚙️ 動作の細かい調整', match: (n) => n.startsWith('set_') || n === 'settings' },
  { label: '🔧 管理・実行', match: (n) => ['force_update', 'daily_report', 'status', 'logs'].includes(n) },
  { label: 'その他', match: () => true },
];

async function help(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📚 XENOGRAM Analytics Bot Commands')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(
      '自分（XENOGRAM）以外のニコニコアカウントも監視したい場合は `/user_add` で追加できます（複数人を同時監視可能）。\n' +
      'マイルストーンの刻み幅・急上昇のしきい値・各定期チェックの実行時刻は `/settings` で確認、`/set_milestone` `/set_spike` `/set_rank_threshold` `/set_schedule` で変更できます。\n' +
      '💡 動画ID等を入力する項目は、入力し始めると候補が自動で出てきます（`/stats` `/remove` `/compare` `/vc_remove` `/user_remove`）。コピペ不要です。\n' +
      '📄 サーバー機のログを見たいときは `/logs` で直近の実行ログ・エラーログをこの場で確認できます。'
    );

  const remaining = [...commands];
  for (const category of CATEGORIES) {
    const inCategory = remaining.filter(cmd => category.match(cmd.name));
    if (!inCategory.length) continue;
    const value = inCategory.map(cmd => `**\`/${cmd.name}\`** : ${cmd.description}`).join('\n');
    embed.addFields({ name: category.label, value, inline: false });
    // 一度カテゴリに割り当てたコマンドは以降の判定から除く
    for (const cmd of inCategory) {
      const idx = remaining.indexOf(cmd);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  }

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
    dbService.getAllVideos(),
    dbService.getVocacolleKeywords(),
    dbService.getVocacolleWatchEnabled()
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
