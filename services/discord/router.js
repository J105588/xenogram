const { sendErrorEmbed } = require('./client');
const dbService = require('../database');
const { isEditSelect, isEditModal, handleEditSelect, handleEditModal } = require('./editors');

const miscCmds = require('./commands/misc');
const videoCmds = require('./commands/videos');
const vocacolleCmds = require('./commands/vocacolle');
const settingsCmds = require('./commands/settings');
const systemCmds = require('./commands/system');
const twitterCmds = require('./commands/twitter');
const guildCmds = require('./commands/guild');

const handlers = {
  ...miscCmds,
  ...videoCmds,
  ...vocacolleCmds,
  ...settingsCmds,
  ...systemCmds,
  ...twitterCmds,
  ...guildCmds,
};

// video_id/id/user_id等、手打ちしにくいIDを入力補完するオートコンプリート。
// コマンドごとに使うオプションは1つだけなので、コマンド名単位の対応でよい。
const AUTOCOMPLETE = {
  stats: videoCmds.autocompleteVideoId,
  remove: videoCmds.autocompleteVideoId,
  compare: videoCmds.autocompleteVideoId,
  vc_remove: vocacolleCmds.autocompleteKeywordId,
  user_remove: settingsCmds.autocompleteUserId,
  set_schedule: settingsCmds.autocompleteScheduleInput,
  x_remove: twitterCmds.autocompleteKeywordId,
};

/**
 * 本人にだけ見えるエラー応答を返す。既に応答済みかどうかで呼び分けが変わるうえ、
 * この応答自体が失敗しても元のエラーを握りつぶしたくないので握りつぶす。
 */
async function replyQuietly(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (err) {
    console.error('Failed to send error message to user:', err);
  }
}

/**
 * このBotの設定・監視対象はすべてサーバー単位で管理されるため、
 * サーバー外（DM）では動かせない。DMでの実行はここで弾く。
 * ついでに、初めてコマンドが使われたサーバーをこの時点で登録しておく
 * （Bot参加イベントを取りこぼしていた場合の保険）。
 * @returns {boolean} 処理を続けてよければ true
 */
function ensureGuildContext(interaction) {
  if (!interaction.guildId) return false;
  dbService.ensureGuild(interaction.guildId, interaction.guild ? interaction.guild.name : null);
  return true;
}

/**
 * client の interactionCreate を、コマンド名に対応するハンドラへ振り分ける。
 * 各ハンドラは (interaction, { client, guildId }) => Promise<void> の形。
 */
function attachInteractionHandler(client) {
  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      const autocompleteHandler = AUTOCOMPLETE[interaction.commandName];
      try {
        if (autocompleteHandler && interaction.guildId) {
          await autocompleteHandler(interaction);
        } else {
          await interaction.respond([]);
        }
      } catch (err) {
        console.error('Autocomplete Error:', err);
        try { await interaction.respond([]); } catch { /* 応答不可なら諦める */ }
      }
      return;
    }

    // 一覧からの編集（セレクトメニュー → モーダル）。
    // showModal は「そのインタラクションへの最初の応答」でなければならないため、
    // 下のコマンド用 deferReply() より先に処理して return する。
    if (interaction.isStringSelectMenu() && isEditSelect(interaction.customId)) {
      if (!ensureGuildContext(interaction)) return;
      try {
        await handleEditSelect(interaction);
      } catch (err) {
        console.error('Edit Select Error:', err);
        await sendErrorEmbed(err, '🚨 Edit Menu Error', interaction.guildId);
        await replyQuietly(interaction, '❌ 編集フォームを開けませんでした。ログを確認してください。');
      }
      return;
    }

    if (interaction.isModalSubmit() && isEditModal(interaction.customId)) {
      if (!ensureGuildContext(interaction)) return;
      try {
        await handleEditModal(interaction);
      } catch (err) {
        console.error('Edit Modal Error:', err);
        await sendErrorEmbed(err, '🚨 Edit Submit Error', interaction.guildId);
        await replyQuietly(interaction, '❌ 保存中にエラーが発生しました。ログを確認してください。');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    const handler = handlers[commandName];

    if (!interaction.guildId) {
      await interaction.reply({
        content: 'このBotはサーバー内でのみ利用できます（設定・監視対象はサーバーごとに管理されるため、DMでは実行できません）。',
        ephemeral: true,
      });
      return;
    }
    ensureGuildContext(interaction);

    try {
      await interaction.deferReply();

      if (!handler) {
        await interaction.editReply(`未対応のコマンドです: /${commandName}`);
        return;
      }
      await handler(interaction, { client, guildId: interaction.guildId });
    } catch (err) {
      console.error("Command Error:", err);

      // エラーはそのコマンドが実行されたサーバーにだけ通知する
      await sendErrorEmbed(err, `🚨 Command Execution Error (/${commandName})`, interaction.guildId);

      try {
        const errorMessage = "❌ コマンドの実行中にエラーが発生しました。詳細なログを確認してください。";
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errorMessage);
        } else {
          await interaction.reply({ content: errorMessage, ephemeral: true });
        }
      } catch (followUpError) {
        console.error("Failed to send error message to user:", followUpError);
      }
    }
  });
}

module.exports = { attachInteractionHandler };
