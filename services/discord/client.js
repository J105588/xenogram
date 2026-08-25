const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../../config');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/**
 * 指定サーバーの通知チャンネルへ送る。
 *
 * 以前は .env の DISCORD_CHANNEL_ID 1つに固定で送っていたが、鯖ごとに
 * 通知先を持てるようにしたため、送信先は guilds テーブルから解決する。
 * 通知先が未設定の鯖には何も送らない（/guild_setup で明示的に指定するまで、
 * Botを入れただけで意図しないチャンネルに流れ出さないようにするため）。
 *
 * @param {string} guildId 送信先サーバーID
 * @param {string|EmbedBuilder} embedOrText
 * @param {'notify'|'video'|'vocacolle'|'twitter'} [kind] 用途別チャンネルの使い分け
 */
async function sendNotification(guildId, embedOrText, kind = 'notify') {
  const dbService = require('../database');
  const channelId = guildId ? dbService.resolveChannelId(guildId, kind) : null;

  if (!channelId) {
    console.warn(`[NOTIFY] 通知先チャンネルが未設定のため送信をスキップします (guild: ${guildId})。/guild_setup で設定してください。`);
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.error(`❌ [ERROR] Channel not found for ID: ${channelId} (guild: ${guildId})`);
      return false;
    }
    if (typeof embedOrText === 'string') await channel.send(embedOrText);
    else await channel.send({ embeds: [embedOrText] });
    return true;
  } catch (error) {
    console.error("❌ [ERROR] Error sending notification to Discord:", error);
    return false;
  }
}

/**
 * 全サーバーへ同じ内容を送る（Bot全体の起動・停止・障害通知など、
 * 特定の鯖に属さない運用連絡用）。
 */
async function broadcastNotification(embedOrText) {
  const dbService = require('../database');
  const guilds = dbService.getActiveGuilds();
  let sent = 0;
  for (const guild of guilds) {
    if (await sendNotification(guild.guild_id, embedOrText)) sent += 1;
  }
  return sent;
}

/**
 * 任意のチャンネルへ Embed（複数可）と添付ファイルを送る（ボカコレ通知用）
 * @param {object} params
 * @param {string} params.channelId 送信先チャンネルID
 * @param {EmbedBuilder} [params.embed] 単一のEmbedを送る場合
 * @param {EmbedBuilder[]} [params.embeds] 複数のEmbedを1メッセージにまとめて送る場合
 * @param {Array<{buffer: Buffer, name: string}>} [params.files] 添付ファイル（各Embedから attachment://ファイル名 で参照できる）
 */
async function sendEmbedWithFiles({ guildId, kind = 'notify', channelId, embed, embeds, files = [] }) {
  const dbService = require('../database');
  const targetId = channelId || (guildId ? dbService.resolveChannelId(guildId, kind) : null);
  if (!targetId) {
    console.warn(`[NOTIFY] 送信先チャンネルが未設定のため送信をスキップします (guild: ${guildId})。`);
    return false;
  }

  const embedList = embeds || (embed ? [embed] : []);
  if (!embedList.length) {
    console.error("[ERROR] 送信するEmbedがありません。");
    return false;
  }

  try {
    const channel = await client.channels.fetch(targetId);
    if (!channel) {
      console.error(`[ERROR] Channel not found for ID: ${targetId}`);
      return false;
    }

    const attachments = files.map(f => new AttachmentBuilder(f.buffer, { name: f.name }));
    await channel.send({ embeds: embedList, files: attachments });
    return true;
  } catch (error) {
    console.error("[ERROR] Failed to send embed with files:", error);
    return false;
  }
}

// 同じエラーが短時間に連発しても通知が連投されないようにする簡易スロットル。
// キー: タイトル+エラー文の先頭200文字、値: { count(抑制した回数), lastSentAt }
const errorThrottle = new Map();
const ERROR_THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5分

/**
 * エラー通知。特定サーバーの処理中に起きたものは その鯖だけに、
 * 鯖に紐づかないもの（起動時の例外など）は全サーバーに送る。
 */
async function sendErrorEmbed(error, title = "🚨 Runtime Error", guildId = null) {
  const errorMessage = error.stack || error.message || String(error);
  const key = `${title}::${errorMessage.slice(0, 200)}`;
  const now = Date.now();
  const prev = errorThrottle.get(key);

  if (prev && now - prev.lastSentAt < ERROR_THROTTLE_WINDOW_MS) {
    prev.count += 1;
    console.warn(`[THROTTLED] 同じエラーの通知を抑制しました（直近5分で${prev.count}回目）: ${title}`);
    return;
  }

  const suppressedNote = prev && prev.count > 0
    ? `\n\n*(直近5分で同じエラーが ${prev.count} 回抑制されました)*`
    : '';
  errorThrottle.set(key, { count: 0, lastSentAt: now });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xff0000)
    .setDescription(`\`\`\`js\n${errorMessage.slice(0, 3900)}\n\`\`\`${suppressedNote}`)
    .setTimestamp();

  if (guildId) await sendNotification(guildId, embed);
  else await broadcastNotification(embed);
}

function startDiscordBot() {
  if (!config.DISCORD.TOKEN) {
    console.error("❌ [CRITICAL] DISCORD_TOKEN is missing! The bot CANNOT log in and will remain offline.");
    return;
  }
  client.login(config.DISCORD.TOKEN).catch(err => {
    console.error("❌ [CRITICAL] Failed to login to Discord. Is the token correct?", err);
  });
}

module.exports = {
  client, startDiscordBot, sendNotification, broadcastNotification, sendEmbedWithFiles, sendErrorEmbed,
};
