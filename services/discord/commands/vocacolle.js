const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');
const { parseJstDateTime, formatJst } = require('../format');
const { buildListMessage } = require('../editors');

// 未セットアップのサーバーで「何も起きない」時に、次に何をすればよいかを必ず示す
const SETUP_HINT = 'まず `/guild_setup channel:#チャンネル` でこのサーバーの通知先を指定してください。';

async function vc_add(interaction, { guildId }) {
  const keyword = interaction.options.getString('keyword');
  const target = interaction.options.getString('target');
  const fromRaw = interaction.options.getString('active_from');
  const untilRaw = interaction.options.getString('active_until');
  const pageId = interaction.options.getString('page_id') || 'rookie';
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

  const { data, error } = await dbService.addVocacolleKeyword({
    guildId, keyword, target, activeFrom, activeUntil, pageId, note
  });

  if (error) {
    const duplicated = error.code === '23505';
    return await interaction.editReply(
      duplicated
        ? `\`${keyword}\` は既に同じ対象（page_id: \`${pageId}\`）で登録されています。`
        : "キーワードの登録に失敗しました。ログを確認してください。"
    );
  }

  const targetLabel = target === 'artist' ? 'アーティスト名' : '曲名';
  const embed = new EmbedBuilder()
    .setTitle('監視キーワードを追加しました')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .addFields(
      { name: "ID", value: String(data.id), inline: true },
      { name: "対象", value: targetLabel, inline: true },
      { name: "ページ", value: `\`${data.page_id}\``, inline: true },
      { name: "キーワード", value: `\`${data.keyword}\``, inline: false },
      { name: "監視開始", value: formatJst(data.active_from), inline: true },
      { name: "監視終了", value: formatJst(data.active_until), inline: true }
    )
    .setFooter({ text: config.FOOTER_TEXT });

  await interaction.editReply({ embeds: [embed] });
}

// 一覧の表示内容とセレクトメニューは editors.js 側に集約している
// （編集保存後に同じメッセージを描き直すため、一覧の組み立ては1か所にまとめる必要がある）。
async function vc_list(interaction, { guildId }) {
  await interaction.editReply(await buildListMessage('vc', guildId, interaction.user.id));
}

async function vc_remove(interaction, { guildId }) {
  const id = interaction.options.getInteger('id');
  const success = await dbService.removeVocacolleKeyword(guildId, id);
  await interaction.editReply(success ? `監視キーワード #${id} を削除しました。` : "削除に失敗しました。");
}

async function vc_check(interaction, { guildId }) {
  await interaction.editReply("ボカコレランキングを確認しています...（/vc_toggle off 中でも実行します）");
  const scheduler = require('../../scheduler');
  // notifySummary: true にして、新規ヒットが無い場合でも定期実行と同じ
  // スクショ付きサマリーがチャンネルに届くようにする（手動確認の見た目を統一）
  const result = await scheduler.runVocacolleWatch(guildId, { bypassToggle: true, notifySummary: true });
  if (result.skipped === 'no_channel') {
    await interaction.followUp(`通知先チャンネルが未設定のため実行しませんでした。\n${SETUP_HINT}`);
  } else if (result.skipped === 'already_running') {
    await interaction.followUp("前回の確認処理がまだ終わっていません。少し待ってからもう一度お試しください（連続実行はメモリ超過の原因になるため制限しています）。");
  } else if (result.skipped === 'no_keywords') {
    await interaction.followUp("監視キーワードが1件も登録されていません。/vc_add で登録してください。");
  } else {
    await interaction.followUp(
      `確認完了: ${result.checked}件を照合し、ヒット ${result.hits}件 / 新規通知 ${result.notified}件でした。`
    );
  }
}

async function vc_toggle(interaction, { guildId }) {
  const state = interaction.options.getString('state');
  const enabled = state === 'on';
  const success = await dbService.setVocacolleWatchEnabled(guildId, enabled);

  if (!success) {
    return await interaction.editReply("設定の更新に失敗しました。ログを確認してください。");
  }

  const scheduler = require('../../scheduler');
  const scheduleNote = scheduler.applyVocacolleLinkedSchedule(guildId, enabled);

  let msg = enabled
    ? `ボカコレ監視を **有効** にしました。次回は毎時5分（JST）に実行されます。`
    : `ボカコレ監視を **無効** にしました。毎時のチェックはスキップされます（/vc_check は引き続き手動実行できます）。`;
  if (scheduleNote) msg += `\n${scheduleNote}`;

  await interaction.editReply(msg);
}

// vc_remove の id オプション用オートコンプリート。
// /vc_list を別途開かなくても、削除対象を選ぶだけで済むようにする。
async function autocompleteKeywordId(interaction) {
  const keywords = await dbService.getVocacolleKeywords(interaction.guildId, true);
  const choices = keywords.slice(0, 25).map((k) => ({
    name: `#${k.id} [${k.target === 'artist' ? 'アーティスト' : '曲名'}] ${k.keyword}`.slice(0, 100),
    value: Number(k.id),
  }));
  await interaction.respond(choices);
}

module.exports = { vc_add, vc_list, vc_remove, vc_check, vc_toggle, autocompleteKeywordId };
