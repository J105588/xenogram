const { EmbedBuilder } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');
const { parseJstDateTime, formatJst } = require('../format');

async function vc_add(interaction) {
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
    keyword, target, activeFrom, activeUntil, pageId, note
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

async function vc_list(interaction) {
  const [keywords, watchEnabled] = await Promise.all([
    dbService.getVocacolleKeywords(true),
    dbService.getVocacolleWatchEnabled()
  ]);
  const watchStateLine = `監視スケジュール: ${watchEnabled ? '**有効** (毎時5分に実行)' : '**無効** (/vc_toggle on で再開)'}`;

  if (!keywords.length) {
    return await interaction.editReply(`${watchStateLine}\n監視キーワードは登録されていません。`);
  }

  const vocacolle = require('../../vocacolle');
  const now = new Date();

  const lines = keywords.map(k => {
    const targetLabel = k.target === 'artist' ? 'アーティスト' : '曲名';
    const state = vocacolle.isActive(k, now) ? '有効' : '期間外/停止中';
    const period = (k.active_from || k.active_until)
      ? `${formatJst(k.active_from)} 〜 ${formatJst(k.active_until)}`
      : '常時';
    return `**#${k.id}** [${targetLabel}] \`${k.keyword}\` (page: \`${k.page_id}\`)\n　${state} / ${period}`;
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

async function vc_remove(interaction) {
  const id = interaction.options.getInteger('id');
  const success = await dbService.removeVocacolleKeyword(id);
  await interaction.editReply(success ? `監視キーワード #${id} を削除しました。` : "削除に失敗しました。");
}

async function vc_check(interaction) {
  await interaction.editReply("ボカコレランキングを確認しています...（/vc_toggle off 中でも実行します）");
  const scheduler = require('../../scheduler');
  // notifySummary: true にして、新規ヒットが無い場合でも定期実行と同じ
  // スクショ付きサマリーがチャンネルに届くようにする（手動確認の見た目を統一）
  const result = await scheduler.runVocacolleWatch({ bypassToggle: true, notifySummary: true });
  if (result.skipped === 'already_running') {
    await interaction.followUp("前回の確認処理がまだ終わっていません。少し待ってからもう一度お試しください（連続実行はメモリ超過の原因になるため制限しています）。");
  } else if (result.skipped === 'no_keywords') {
    await interaction.followUp("監視キーワードが1件も登録されていません。/vc_add で登録してください。");
  } else {
    await interaction.followUp(
      `確認完了: ${result.checked}件を照合し、ヒット ${result.hits}件 / 新規通知 ${result.notified}件でした。`
    );
  }
}

async function vc_toggle(interaction) {
  const state = interaction.options.getString('state');
  const enabled = state === 'on';
  const success = await dbService.setVocacolleWatchEnabled(enabled);

  if (!success) {
    return await interaction.editReply("設定の更新に失敗しました。ログを確認してください。");
  }

  const scheduler = require('../../scheduler');
  const scheduleNote = scheduler.applyVocacolleLinkedSchedule(enabled);

  let msg = enabled
    ? `ボカコレ監視を **有効** にしました。次回は毎時5分（JST）に実行されます。`
    : `ボカコレ監視を **無効** にしました。毎時のチェックはスキップされます（/vc_check は引き続き手動実行できます）。`;
  if (scheduleNote) msg += `\n${scheduleNote}`;

  await interaction.editReply(msg);
}

// vc_remove の id オプション用オートコンプリート。
// /vc_list を別途開かなくても、削除対象を選ぶだけで済むようにする。
async function autocompleteKeywordId(interaction) {
  const keywords = await dbService.getVocacolleKeywords(true);
  const choices = keywords.slice(0, 25).map((k) => ({
    name: `#${k.id} [${k.target === 'artist' ? 'アーティスト' : '曲名'}] ${k.keyword}`.slice(0, 100),
    value: Number(k.id),
  }));
  await interaction.respond(choices);
}

module.exports = { vc_add, vc_list, vc_remove, vc_check, vc_toggle, autocompleteKeywordId };
