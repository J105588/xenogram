const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');

async function user_add(interaction) {
  const userId = interaction.options.getString('user_id').trim();
  const label = interaction.options.getString('label');

  if (!/^\d+$/.test(userId)) {
    return await interaction.editReply('ユーザーIDは数字のみで指定してください（例: 143305795）。');
  }

  const result = dbService.addNicoUser(userId, label);
  if (!result.ok) {
    return await interaction.editReply(
      result.reason === 'duplicate' ? `\`${userId}\` は既に登録されています。` : '追加に失敗しました。ログを確認してください。'
    );
  }

  const all = dbService.getNicoUserIds();
  await interaction.editReply(`✅ ニコニコユーザー \`${userId}\`${label ? `（${label}）` : ''} を監視対象に追加しました。現在 ${all.length}人を監視中です。`);
}

async function user_remove(interaction) {
  const userId = interaction.options.getString('user_id').trim();
  const success = dbService.removeNicoUser(userId);
  await interaction.editReply(
    success ? `🗑️ \`${userId}\` を監視対象から削除しました。` : `\`${userId}\` は登録されていません（/user_list で確認できます）。`
  );
}

async function user_list(interaction) {
  const users = dbService.getNicoUsersDetailed();
  const source = users.length && users[0].fromEnv ? '（.envのNICO_USER_IDSから）' : '（/user_add で登録）';

  const lines = users.map(u => `• \`${u.user_id}\`${u.label ? ` — ${u.label}` : ''}`);
  const embed = new EmbedBuilder()
    .setTitle(`📡 監視中のニコニコユーザー (${users.length}人) ${source}`)
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(lines.join('\n') || 'なし')
    .addFields({
      name: '別のユーザーを追加するには',
      value: '`/user_add user_id:143305795 label:任意のメモ`\n一度追加すると、.envのNICO_USER_IDSより登録内容が優先されます。',
      inline: false
    })
    .setFooter({ text: config.FOOTER_TEXT });

  await interaction.editReply({ embeds: [embed] });
}

async function set_milestone(interaction) {
  const step = interaction.options.getInteger('step');
  if (!Number.isInteger(step) || step <= 0) {
    return await interaction.editReply('1以上の整数を指定してください。');
  }
  dbService.setSetting('milestone_step', step);
  await interaction.editReply(`✅ マイルストーンの判定単位を **${step}** に変更しました（次回のチェックから反映されます）。`);
}

async function set_spike(interaction) {
  const threshold = interaction.options.getInteger('threshold');
  const cooldownHours = interaction.options.getInteger('cooldown_hours');

  if (!Number.isInteger(threshold) || threshold <= 0) {
    return await interaction.editReply('threshold は1以上の整数を指定してください。');
  }
  dbService.setSetting('spike_view_threshold_per_hour', threshold);

  let msg = `✅ 急上昇のしきい値を **1時間あたり${threshold}再生** に変更しました。`;
  if (cooldownHours !== null) {
    if (!Number.isInteger(cooldownHours) || cooldownHours <= 0) {
      return await interaction.editReply('cooldown_hours は1以上の整数を指定してください。');
    }
    dbService.setSetting('spike_cooldown_hours', cooldownHours);
    msg += `\nクールダウンを **${cooldownHours}時間** に変更しました。`;
  }
  await interaction.editReply(msg);
}

async function set_rank_threshold(interaction) {
  const positions = interaction.options.getInteger('positions');
  if (!Number.isInteger(positions) || positions <= 0) {
    return await interaction.editReply('1以上の整数を指定してください。');
  }
  dbService.setSetting('vocacolle_rank_change_threshold', positions);
  await interaction.editReply(`✅ 順位変動通知のしきい値を **${positions}位** に変更しました。`);
}

async function set_schedule(interaction) {
  const job = interaction.options.getString('job');
  const cronExpr = interaction.options.getString('cron').trim();

  const scheduler = require('../../scheduler');
  const result = scheduler.rescheduleJob(job, cronExpr);

  if (!result.ok) {
    const message = result.reason === 'invalid_cron'
      ? `\`${cronExpr}\` は正しいcron形式ではありません。\n` +
        `「分 時 日 月 曜日」の5項目をスペース区切りで指定してください（値を指定しない項目は \`*\`）。\n` +
        `例: \`5 * * * *\` = 毎時5分 / \`0 7 * * *\` = 毎朝7時0分 / \`0 21 * * 0\` = 毎週日曜21時0分`
      : '対象ジョブが見つかりませんでした。';
    return await interaction.editReply(message);
  }

  await interaction.editReply(`✅ スケジュールを \`${cronExpr}\` に変更しました。`);
}

async function settings(interaction) {
  const s = dbService.getAllSettingsWithSource();
  const byKey = Object.fromEntries(s.map(x => [x.key, x]));

  const format = (key, unit = '') => {
    const item = byKey[key];
    const overriddenNote = item.overridden ? '' : '（デフォルト）';
    return `${item.value}${unit} ${overriddenNote}`;
  };

  const scheduler = require('../../scheduler');
  const jobs = scheduler.listJobs();

  const embed = new EmbedBuilder()
    .setTitle('⚙️ 現在の設定')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .addFields(
      { name: 'マイルストーン単位', value: format('milestone_step', '再生/いいね等'), inline: true },
      { name: '急上昇しきい値', value: format('spike_view_threshold_per_hour', '再生/時'), inline: true },
      { name: '急上昇クールダウン', value: format('spike_cooldown_hours', '時間'), inline: true },
      { name: 'ボカコレ順位変動しきい値', value: format('vocacolle_rank_change_threshold', '位'), inline: true },
      {
        name: '実行スケジュール',
        value: jobs.map(j => `**${j.label}**: \`${j.cron}\``).join('\n'),
        inline: false
      }
    )
    .setFooter({ text: '変更は /set_milestone /set_spike /set_rank_threshold /set_schedule で可能' });

  await interaction.editReply({ embeds: [embed] });
}

// user_remove の user_id オプション用オートコンプリート
async function autocompleteUserId(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const users = dbService.getNicoUsersDetailed();
  const choices = users
    .filter((u) => u.user_id.includes(focused) || (u.label || '').toLowerCase().includes(focused))
    .slice(0, 25)
    .map((u) => ({ name: `${u.user_id}${u.label ? ` - ${u.label}` : ''}`.slice(0, 100), value: u.user_id }));
  await interaction.respond(choices);
}

module.exports = { user_add, user_remove, user_list, set_milestone, set_spike, set_rank_threshold, set_schedule, settings, autocompleteUserId };
