const {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType,
} = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');
const { commands } = require('../definitions');
const { formatJst } = require('../format');

// コマンド名の接頭辞でカテゴリ分けする。
// 全カテゴリを1つのEmbedに詰め込むと文字量が多すぎて読みにくいため、
// /help では概要だけを見せ、下のセレクトメニューで選んだカテゴリだけを表示する。
const CATEGORIES = [
  { key: 'videos', emoji: '📺', label: '動画の監視', match: (n) => ['stats', 'list', 'add', 'remove', 'compare', 'ranking', 'growth', 'upcoming', 'export'].includes(n) },
  { key: 'vocacolle', emoji: '🎯', label: 'ボカコレ/ランキング監視', match: (n) => n.startsWith('vc_') },
  { key: 'twitter', emoji: '🐦', label: 'X(Twitter)キーワード監視（読み取り専用）', match: (n) => n.startsWith('x_') },
  { key: 'users', emoji: '📡', label: '監視対象ユーザー（複数のニコニコアカウントを追う）', match: (n) => n.startsWith('user_') },
  { key: 'config', emoji: '⚙️', label: '動作の細かい調整', match: (n) => n.startsWith('set_') || n === 'settings' },
  { key: 'admin', emoji: '🔧', label: '管理・実行', match: (n) => ['force_update', 'daily_report', 'restart', 'status', 'logs'].includes(n) },
  { key: 'misc', emoji: '💬', label: 'その他', match: () => true },
];

const HELP_TIMEOUT_MS = 5 * 60 * 1000; // このメニューは5分間操作が無いと自動的に閉じる（無効化される）

/**
 * 各コマンドをちょうど1つのカテゴリに振り分ける（CATEGORIES の順に判定し、
 * 先に一致した方を優先。'その他' が catch-all として最後に残りを拾う）。
 */
function groupCommandsByCategory() {
  const remaining = [...commands];
  const grouped = new Map();
  for (const category of CATEGORIES) {
    const inCategory = remaining.filter((cmd) => category.match(cmd.name));
    grouped.set(category.key, inCategory);
    for (const cmd of inCategory) {
      const idx = remaining.indexOf(cmd);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  }
  return grouped;
}

function buildOverviewEmbed(grouped) {
  const summaryLines = CATEGORIES
    .filter((c) => grouped.get(c.key).length)
    .map((c) => `${c.emoji} **${c.label}** — ${grouped.get(c.key).length}個`);

  return new EmbedBuilder()
    .setTitle('📚 XENOGRAM コマンド一覧')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(
      '下のメニューからカテゴリを選ぶと、そのコマンドの説明だけが表示されます。\n\n' +
      summaryLines.join('\n')
    )
    .addFields({
      name: '💡 知っておくと便利な機能',
      value:
        '・動画ID等の入力項目は、打ち始めると候補が自動で出ます（コピペ不要）\n' +
        '・現在の設定値は `/settings`、稼働状況は `/status` で確認できます\n' +
        '・サーバー機のログは `/logs` でこの場に呼び出せます（管理者限定）',
      inline: false,
    })
    .setFooter({ text: `${config.FOOTER_TEXT} ・ メニューは5分間だけ操作できます` });
}

function buildCategoryEmbed(category, cmds) {
  const value = cmds.map((cmd) => `**\`/${cmd.name}\`**\n${cmd.description}`).join('\n\n');
  return new EmbedBuilder()
    .setTitle(`${category.emoji} ${category.label}`)
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(value)
    .setFooter({ text: '他のカテゴリを見るには、下のメニューから選び直してください' });
}

function buildCategoryMenu(selectedKey, grouped, { disabled = false } = {}) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('xenogram-help-category')
    .setPlaceholder(disabled ? 'タイムアウトしました（もう一度 /help を実行してください）' : 'カテゴリを選んで詳細を見る')
    .setDisabled(disabled)
    .addOptions(
      CATEGORIES.filter((c) => grouped.get(c.key).length).map((c) => ({
        label: `${c.emoji} ${c.label}`,
        value: c.key,
        description: `${grouped.get(c.key).length}個のコマンド`,
        default: c.key === selectedKey,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

async function help(interaction) {
  const grouped = groupCommandsByCategory();
  const overviewEmbed = buildOverviewEmbed(grouped);
  const row = buildCategoryMenu(null, grouped);

  const message = await interaction.editReply({ embeds: [overviewEmbed], components: [row] });

  // このメニューを開いた本人以外が操作できないようにする
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: HELP_TIMEOUT_MS,
  });

  collector.on('collect', async (menuInteraction) => {
    if (menuInteraction.user.id !== interaction.user.id) {
      await menuInteraction.reply({ content: 'このメニューはコマンドを実行した本人だけが操作できます。', ephemeral: true });
      return;
    }
    const key = menuInteraction.values[0];
    const category = CATEGORIES.find((c) => c.key === key);
    const embed = buildCategoryEmbed(category, grouped.get(key));
    await menuInteraction.update({ embeds: [embed], components: [buildCategoryMenu(key, grouped)] });
  });

  collector.on('end', async (_collected, reason) => {
    if (reason !== 'time') return; // 別カテゴリ選択などによる正常終了では何もしない
    try {
      await interaction.editReply({ components: [buildCategoryMenu(null, grouped, { disabled: true })] });
    } catch (_) {
      // 元メッセージが削除済み等で編集できない場合は諦める（best-effort）
    }
  });
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

  let twitterLine = 'セットアップ未完了（TWITTER_MONITOR_ENABLED=false）';
  if (config.TWITTER_MONITOR.ENABLED) {
    const twitterCli = require('../../twitterCli');
    const [twitterKeywords, twitterEnabled, cliAvailable] = await Promise.all([
      dbService.getTwitterKeywords(),
      dbService.getTwitterMonitorEnabled(),
      twitterCli.isCliAvailable(),
    ]);
    twitterLine = `${twitterEnabled ? '有効' : '無効'} / キーワード${twitterKeywords.length}件 / twitter-cli: ${cliAvailable ? '検出済み' : '未検出'}`;
  }

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
      { name: 'X(Twitter)監視', value: twitterLine, inline: true },
      { name: '毎時 新着/キリ番チェック 最終実行', value: formatLastRun(lastRun.updateVideoList), inline: false },
      { name: '毎朝 デイリーレポート 最終実行', value: formatLastRun(lastRun.reportEachVideoStats), inline: false },
      { name: 'ボカコレ監視 最終実行', value: formatLastRun(lastRun.vocacolleWatch), inline: false },
      { name: '週次レポート 最終実行', value: formatLastRun(lastRun.weeklyReport), inline: false },
      { name: 'X(Twitter)監視 最終実行', value: formatLastRun(lastRun.twitterWatch), inline: false }
    )
    .setFooter({ text: config.FOOTER_TEXT })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { help, ping, status };
