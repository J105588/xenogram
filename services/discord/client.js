const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../../config');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function sendNotification(embedOrText) {
  if (!config.DISCORD.CHANNEL_ID) {
    console.error("❌ [CRITICAL] DISCORD_CHANNEL_ID is missing in config. Cannot send notification.");
    return false;
  }
  try {
    const channel = await client.channels.fetch(config.DISCORD.CHANNEL_ID);
    if (!channel) {
      console.error(`❌ [ERROR] Channel not found for ID: ${config.DISCORD.CHANNEL_ID}`);
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
 * 任意のチャンネルへ Embed（複数可）と添付ファイルを送る（ボカコレ通知用）
 * @param {object} params
 * @param {string} params.channelId 送信先チャンネルID
 * @param {EmbedBuilder} [params.embed] 単一のEmbedを送る場合
 * @param {EmbedBuilder[]} [params.embeds] 複数のEmbedを1メッセージにまとめて送る場合
 * @param {Array<{buffer: Buffer, name: string}>} [params.files] 添付ファイル（各Embedから attachment://ファイル名 で参照できる）
 */
async function sendEmbedWithFiles({ channelId, embed, embeds, files = [] }) {
  const targetId = channelId || config.DISCORD.CHANNEL_ID;
  if (!targetId) {
    console.error("[ERROR] 送信先チャンネルIDが設定されていません。");
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

async function sendErrorEmbed(error, title = "🚨 Runtime Error") {
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

  await sendNotification(embed);
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

module.exports = { client, startDiscordBot, sendNotification, sendEmbedWithFiles, sendErrorEmbed };
