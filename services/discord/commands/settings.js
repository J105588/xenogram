const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');
const { buildListMessage } = require('../editors');

async function user_add(interaction, { guildId }) {
  const userId = interaction.options.getString('user_id').trim();
  const label = interaction.options.getString('label');

  if (!/^\d+$/.test(userId)) {
    return await interaction.editReply('ユーザーIDは数字のみで指定してください（例: 143305795）。');
  }

  const result = dbService.addNicoUser(guildId, userId, label);
  if (!result.ok) {
    return await interaction.editReply(
      result.reason === 'duplicate' ? `\`${userId}\` は既に登録されています。` : '追加に失敗しました。ログを確認してください。'
    );
  }

  const all = dbService.getNicoUserIds(guildId);
  await interaction.editReply(`✅ ニコニコユーザー \`${userId}\`${label ? `（${label}）` : ''} を監視対象に追加しました。現在 ${all.length}人を監視中です。`);
}

async function user_remove(interaction, { guildId }) {
  const userId = interaction.options.getString('user_id').trim();
  const success = dbService.removeNicoUser(guildId, userId);
  await interaction.editReply(
    success ? `🗑️ \`${userId}\` を監視対象から削除しました。` : `\`${userId}\` は登録されていません（/user_list で確認できます）。`
  );
}

// 一覧の中身とセレクトメニューは editors.js に集約（vc_list と同じ理由）
async function user_list(interaction, { guildId }) {
  await interaction.editReply(await buildListMessage('user', guildId, interaction.user.id));
}

async function set_milestone(interaction, { guildId }) {
  const step = interaction.options.getInteger('step');
  if (!Number.isInteger(step) || step <= 0) {
    return await interaction.editReply('1以上の整数を指定してください。');
  }
  dbService.setSetting(guildId, 'milestone_step', step);
  await interaction.editReply(`✅ マイルストーンの判定単位を **${step}** に変更しました（次回のチェックから反映されます）。`);
}

async function set_spike(interaction, { guildId }) {
  const threshold = interaction.options.getInteger('threshold');
  const cooldownHours = interaction.options.getInteger('cooldown_hours');

  if (!Number.isInteger(threshold) || threshold <= 0) {
    return await interaction.editReply('threshold は1以上の整数を指定してください。');
  }
  dbService.setSetting(guildId, 'spike_view_threshold_per_hour', threshold);

  let msg = `✅ 急上昇のしきい値を **1時間あたり${threshold}再生** に変更しました。`;
  if (cooldownHours !== null) {
    if (!Number.isInteger(cooldownHours) || cooldownHours <= 0) {
      return await interaction.editReply('cooldown_hours は1以上の整数を指定してください。');
    }
    dbService.setSetting(guildId, 'spike_cooldown_hours', cooldownHours);
    msg += `\nクールダウンを **${cooldownHours}時間** に変更しました。`;
  }
  await interaction.editReply(msg);
}

async function set_rank_threshold(interaction, { guildId }) {
  const positions = interaction.options.getInteger('positions');
  if (!Number.isInteger(positions) || positions <= 0) {
    return await interaction.editReply('1以上の整数を指定してください。');
  }
  dbService.setSetting(guildId, 'vocacolle_rank_change_threshold', positions);
  await interaction.editReply(`✅ 順位変動通知のしきい値を **${positions}位** に変更しました。`);
}

async function set_schedule(interaction, { guildId }) {
  const job = interaction.options.getString('job');
  const input = interaction.options.getString('cron').trim();

  const scheduler = require('../../scheduler');
  const result = scheduler.rescheduleJob(guildId, job, input);

  if (!result.ok) {
    if (result.reason === 'invalid_format') {
      const { SHAPE_EXAMPLES } = require('../../cronFriendly');
      const example = SHAPE_EXAMPLES[result.scheduleShape] || '';
      return await interaction.editReply(
        `\`${input}\` を解釈できませんでした。\n` +
        `入力例: ${example}\n` +
        `（cron式を直接入力することもできます。例: \`5 * * * *\`）`
      );
    }
    return await interaction.editReply('対象ジョブが見つかりませんでした。');
  }

  await interaction.editReply(`✅ スケジュールを \`${result.cronExpr}\`（入力: \`${input}\`）に変更しました。`);
}

async function settings(interaction, { guildId }) {
  const s = dbService.getAllSettingsWithSource(guildId);
  const byKey = Object.fromEntries(s.map(x => [x.key, x]));

  const format = (key, unit = '') => {
    const item = byKey[key];
    const overriddenNote = item.overridden ? '' : '（デフォルト）';
    return `${item.value}${unit} ${overriddenNote}`;
  };

  const scheduler = require('../../scheduler');
  const jobs = scheduler.listJobs(guildId);

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

// set_schedule の cron オプション用オートコンプリート。
// 選択済みのジョブ（毎時/毎日/毎週）に応じて、そのまま選ぶだけで使えるプリセットを提示する。
const SCHEDULE_PRESETS = {
  hourly: [
    { value: '0分', note: '毎時0分' },
    { value: '5分', note: '毎時5分' },
    { value: '15分', note: '毎時15分' },
    { value: '30分', note: '毎時30分' },
    { value: '45分', note: '毎時45分' },
  ],
  daily: [
    { value: '7時', note: '毎朝7時' },
    { value: '7時30分', note: '毎朝7時30分' },
    { value: '9時', note: '毎朝9時' },
    { value: '21時', note: '毎晩21時' },
  ],
  weekly: [
    { value: '日 21時', note: '毎週日曜21時' },
    { value: '月 9時', note: '毎週月曜9時' },
    { value: '金 18時', note: '毎週金曜18時' },
    { value: '土 12時', note: '毎週土曜12時' },
  ],
};

async function autocompleteScheduleInput(interaction) {
  const scheduler = require('../../scheduler');
  const job = interaction.options.getString('job');
  const def = scheduler.listJobs(interaction.guildId).find((j) => j.key === job);
  const list = def ? SCHEDULE_PRESETS[def.scheduleShape] : Object.values(SCHEDULE_PRESETS).flat();

  const focused = (interaction.options.getFocused() || '').toLowerCase();
  const choices = list
    .filter((p) => p.value.toLowerCase().includes(focused) || p.note.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((p) => ({ name: `${p.value}（${p.note}）`, value: p.value }));

  await interaction.respond(choices);
}

// user_remove の user_id オプション用オートコンプリート
async function autocompleteUserId(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const users = dbService.getNicoUsersDetailed(interaction.guildId);
  const choices = users
    .filter((u) => u.user_id.includes(focused) || (u.label || '').toLowerCase().includes(focused))
    .slice(0, 25)
    .map((u) => ({ name: `${u.user_id}${u.label ? ` - ${u.label}` : ''}`.slice(0, 100), value: u.user_id }));
  await interaction.respond(choices);
}

module.exports = {
  user_add, user_remove, user_list, set_milestone, set_spike, set_rank_threshold, set_schedule, settings,
  autocompleteUserId, autocompleteScheduleInput,
};
