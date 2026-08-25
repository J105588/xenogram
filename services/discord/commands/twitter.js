const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');
const { buildListMessage } = require('../editors');

async function x_add(interaction, { guildId }) {
  const query = interaction.options.getString('query').trim();
  const note = interaction.options.getString('note');

  if (!config.TWITTER_MONITOR.ENABLED) {
    return await interaction.editReply(
      '⚠️ X監視は現在無効です（TWITTER_MONITOR_ENABLED=false）。キーワードは登録されますが、' +
      'TWITTER_CT0/TWITTER_AUTH_TOKENの設定と環境変数の有効化が完了するまで実行はされません。'
    );
  }

  const result = dbService.addTwitterKeyword(guildId, query, note);
  if (!result.ok) {
    return await interaction.editReply(
      result.reason === 'duplicate' ? `\`${query}\` は既に登録されています。` : '追加に失敗しました。ログを確認してください。'
    );
  }

  const embed = new EmbedBuilder()
    .setTitle('X 監視キーワードを追加しました')
    .setColor(0x1d9bf0)
    .addFields(
      { name: 'ID', value: String(result.data.id), inline: true },
      { name: '検索キーワード', value: `\`${result.data.query}\``, inline: false },
      { name: 'メモ', value: result.data.note || 'なし', inline: false }
    )
    .setFooter({ text: config.FOOTER_TEXT });

  await interaction.editReply({ embeds: [embed] });
}

// 一覧の中身とセレクトメニューは editors.js に集約（vc_list と同じ理由）
async function x_list(interaction, { guildId }) {
  await interaction.editReply(await buildListMessage('x', guildId, interaction.user.id));
}

async function x_remove(interaction, { guildId }) {
  const id = interaction.options.getInteger('id');
  const success = dbService.removeTwitterKeyword(guildId, id);
  await interaction.editReply(success ? `🗑️ X監視キーワード #${id} を削除しました。` : '削除に失敗しました。');
}

async function x_check(interaction, { guildId }) {
  if (!config.TWITTER_MONITOR.ENABLED) {
    return await interaction.editReply(
      '⚠️ X監視は現在無効です（TWITTER_MONITOR_ENABLED=false）。.env の TWITTER_CT0/TWITTER_AUTH_TOKEN の設定を確認してください。'
    );
  }

  await interaction.editReply('Xを検索しています…（/x_toggle off 中でも実行します）');
  const scheduler = require('../../scheduler');
  const result = await scheduler.runTwitterWatch(guildId, { bypassToggle: true });

  if (result.skipped === 'no_channel') {
    await interaction.followUp(
      '通知先チャンネルが未設定のため実行しませんでした。\nまず `/guild_setup channel:#チャンネル` で通知先を指定してください。'
    );
  } else if (result.skipped === 'already_running') {
    await interaction.followUp('前回の確認処理がまだ終わっていません。少し待ってからもう一度お試しください。');
  } else if (result.skipped === 'no_keywords') {
    await interaction.followUp('監視キーワードが1件も登録されていません。/x_add で登録してください。');
  } else if (result.skipped === 'cli_unavailable') {
    await interaction.followUp(
      '❌ TWITTER_CT0 / TWITTER_AUTH_TOKEN が未設定です。.env に設定してください。'
    );
  } else if (result.failedKeywords > 0) {
    await interaction.followUp(
      `⚠️ 確認完了: ${result.checked}件中 **${result.failedKeywords}件の検索が失敗**しました（ヒット ${result.hits}件 / 新規通知 ${result.notified}件）。\n` +
      `直近のエラー: \`${result.lastError}\`\n` +
      'Cookie（ct0/auth_token）の期限切れ、またはXの仕様変更への未対応の可能性があります。詳細はサーバーログをご確認ください。'
    );
  } else {
    await interaction.followUp(`確認完了: ${result.checked}件のキーワードを検索し、ヒット ${result.hits}件 / 新規通知 ${result.notified}件でした。`);
  }
}

async function x_toggle(interaction, { guildId }) {
  const state = interaction.options.getString('state');
  const enabled = state === 'on';
  const success = dbService.setTwitterMonitorEnabled(guildId, enabled);

  if (!success) {
    return await interaction.editReply('設定の更新に失敗しました。ログを確認してください。');
  }

  await interaction.editReply(
    enabled
      ? 'X監視を **有効** にしました。' + (config.TWITTER_MONITOR.ENABLED ? '次回のスケジュールから実行されます。' : '（TWITTER_MONITOR_ENABLED=false のため、.envの設定が完了するまで実際には実行されません）')
      : 'X監視を **無効** にしました。定期チェックはスキップされます（/x_check は引き続き手動実行できます）。'
  );
}

async function autocompleteKeywordId(interaction) {
  const keywords = dbService.getTwitterKeywords(interaction.guildId, true);
  const choices = keywords.slice(0, 25).map((k) => ({
    name: `#${k.id} ${k.query}`.slice(0, 100),
    value: Number(k.id),
  }));
  await interaction.respond(choices);
}

module.exports = { x_add, x_list, x_remove, x_check, x_toggle, autocompleteKeywordId };
