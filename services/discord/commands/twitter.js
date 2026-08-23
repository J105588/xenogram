const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');

async function x_add(interaction) {
  const query = interaction.options.getString('query').trim();
  const note = interaction.options.getString('note');

  if (!config.TWITTER_MONITOR.ENABLED) {
    return await interaction.editReply(
      '⚠️ X監視は現在無効です（TWITTER_MONITOR_ENABLED=false）。キーワードは登録されますが、' +
      'twitter-cliのセットアップと環境変数の有効化が完了するまで実行はされません。'
    );
  }

  const result = dbService.addTwitterKeyword(query, note);
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

async function x_list(interaction) {
  const keywords = dbService.getTwitterKeywords(true);
  const watchEnabled = dbService.getTwitterMonitorEnabled();
  const configEnabled = config.TWITTER_MONITOR.ENABLED;

  const stateLine = !configEnabled
    ? '監視状態: **未セットアップ**（TWITTER_MONITOR_ENABLED=false。.env設定とtwitter-cliのセットアップが必要）'
    : `監視スケジュール: ${watchEnabled ? '**有効**' : '**無効** (/x_toggle on で再開)'}`;

  if (!keywords.length) {
    return await interaction.editReply(`${stateLine}\n監視キーワードは登録されていません。`);
  }

  const lines = keywords.map((k) => `**#${k.id}** \`${k.query}\`${k.enabled ? '' : '（無効）'}${k.note ? ` — ${k.note}` : ''}`);
  let desc = `${stateLine}\n\n${lines.join('\n')}`;
  if (desc.length > 4000) desc = desc.slice(0, 3900) + '\n... (省略されました)';

  const embed = new EmbedBuilder()
    .setTitle(`X 監視キーワード (${keywords.length}件)`)
    .setColor(0x1d9bf0)
    .setDescription(desc)
    .setFooter({ text: config.FOOTER_TEXT });

  await interaction.editReply({ embeds: [embed] });
}

async function x_remove(interaction) {
  const id = interaction.options.getInteger('id');
  const success = dbService.removeTwitterKeyword(id);
  await interaction.editReply(success ? `🗑️ X監視キーワード #${id} を削除しました。` : '削除に失敗しました。');
}

async function x_check(interaction) {
  if (!config.TWITTER_MONITOR.ENABLED) {
    return await interaction.editReply(
      '⚠️ X監視は現在無効です（TWITTER_MONITOR_ENABLED=false）。.env の設定とtwitter-cliのセットアップを確認してください。'
    );
  }

  await interaction.editReply('Xを検索しています…（/x_toggle off 中でも実行します）');
  const scheduler = require('../../scheduler');
  const result = await scheduler.runTwitterWatch({ bypassToggle: true });

  if (result.skipped === 'already_running') {
    await interaction.followUp('前回の確認処理がまだ終わっていません。少し待ってからもう一度お試しください。');
  } else if (result.skipped === 'no_keywords') {
    await interaction.followUp('監視キーワードが1件も登録されていません。/x_add で登録してください。');
  } else if (result.skipped === 'cli_unavailable') {
    await interaction.followUp(
      `❌ twitter-cli（\`${config.TWITTER_MONITOR.CLI_BIN}\`）が見つかりませんでした。インストールとPATH設定を確認してください。` +
      '\n参考: https://github.com/public-clis/twitter-cli'
    );
  } else if (result.failedKeywords > 0) {
    await interaction.followUp(
      `⚠️ 確認完了: ${result.checked}件中 **${result.failedKeywords}件の検索が失敗**しました（新規ヒット ${result.hits}件 / 通知 ${result.notified}件）。\n` +
      `直近のエラー: \`${result.lastError}\`\n` +
      'twitter-cli側の一時的な不調、またはXの仕様変更への未対応の可能性があります。詳細はサーバーログをご確認ください。'
    );
  } else {
    await interaction.followUp(`確認完了: ${result.checked}件のキーワードを検索し、新規ヒット ${result.hits}件 / 通知 ${result.notified}件でした。`);
  }
}

async function x_toggle(interaction) {
  const state = interaction.options.getString('state');
  const enabled = state === 'on';
  const success = dbService.setTwitterMonitorEnabled(enabled);

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
  const keywords = dbService.getTwitterKeywords(true);
  const choices = keywords.slice(0, 25).map((k) => ({
    name: `#${k.id} ${k.query}`.slice(0, 100),
    value: Number(k.id),
  }));
  await interaction.respond(choices);
}

module.exports = { x_add, x_list, x_remove, x_check, x_toggle, autocompleteKeywordId };
