const { EmbedBuilder, ChannelType } = require('discord.js');
const config = require('../../../config');
const dbService = require('../../database');

/* =====================================================================
 * サーバーごとの通知先設定。
 *
 * 通知先は以前 .env の DISCORD_CHANNEL_ID 1つに固定されており、
 * Botを別のサーバーに入れても通知はすべて元のサーバーに流れていた。
 * ここで鯖ごとに指定できるようにする。
 * 未設定の間はその鯖に一切通知を送らない（Botを入れただけで
 * 意図しないチャンネルに流れ出さないための安全側の既定）。
 * ===================================================================== */

const KIND_LABELS = {
  notify: '通常の通知（レポート・新着・キリ番・急上昇）',
  vocacolle: 'ボカコレ/ランキング監視',
  twitter: 'X(Twitter)監視',
};

async function guild_setup(interaction, { guildId }) {
  const kind = interaction.options.getString('kind') || 'notify';
  const channel = interaction.options.getChannel('channel');

  // channel 未指定は「解除」。ただし通常通知を解除すると
  // そのサーバーは実質すべての通知が止まるので、その旨を明示する。
  if (!channel) {
    const result = dbService.setGuildChannel(guildId, kind, null);
    if (!result.ok) return await interaction.editReply('不明な通知種別です。');
    return await interaction.editReply(
      `${KIND_LABELS[kind]} の通知先を **解除** しました。` +
      (kind === 'notify'
        ? '\nこのサーバーには通知が届かなくなります（再開するには `/guild_setup channel:#チャンネル` を実行してください）。'
        : `\n以降は通常の通知チャンネルにまとめて送られます。`)
    );
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return await interaction.editReply('テキストチャンネル（またはアナウンスチャンネル）を指定してください。');
  }

  // 設定した直後に「実は権限が無くて届かない」となるのが一番わかりにくいので、
  // 保存する前に実際に送信できるかを確認する。
  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms || !perms.has('ViewChannel') || !perms.has('SendMessages') || !perms.has('EmbedLinks')) {
    return await interaction.editReply(
      `${channel} に送信する権限がありません。\n` +
      'Botに「チャンネルを見る」「メッセージを送信」「埋め込みリンク」の権限を与えてから、もう一度実行してください。'
    );
  }

  const result = dbService.setGuildChannel(guildId, kind, channel.id);
  if (!result.ok) return await interaction.editReply('不明な通知種別です。');

  const guild = result.data;
  const show = (id) => (id ? `<#${id}>` : '未設定（通常の通知先を使用）');

  const embed = new EmbedBuilder()
    .setTitle('このサーバーの通知先を設定しました')
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(`${KIND_LABELS[kind]} → ${channel}`)
    .addFields(
      { name: '通常の通知', value: guild.notify_channel_id ? `<#${guild.notify_channel_id}>` : '**未設定**', inline: false },
      { name: 'ボカコレ監視', value: show(guild.vocacolle_channel_id), inline: true },
      { name: 'X(Twitter)監視', value: show(guild.twitter_channel_id), inline: true }
    )
    .setFooter({ text: `${config.FOOTER_TEXT} ・ 監視対象と設定はサーバーごとに独立しています` });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * DISCORD_GUILD_ID 未設定で起動したために 'legacy' に退避された既存データを、
 * このサーバーの所有として引き取る。
 */
async function guild_adopt(interaction, { guildId }) {
  const result = dbService.adoptLegacyData(guildId);

  if (!result.ok) {
    return await interaction.editReply(
      result.reason === 'no_legacy_data'
        ? '引き継ぐ対象の旧データはありません（既にどこかのサーバーが引き取り済みか、最初から鯖ごとに登録されています）。'
        : '引き継ぎ先として指定できないサーバーです。'
    );
  }

  const lines = Object.entries(result.moved)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `・${table}: ${count}件`);

  await interaction.editReply(
    `旧データをこのサーバーに引き継ぎました。\n${lines.join('\n') || '（移動対象はありませんでした）'}` +
    '\n\n`/guild_setup` で通知先を確認してください。'
  );
}

module.exports = { guild_setup, guild_adopt };
