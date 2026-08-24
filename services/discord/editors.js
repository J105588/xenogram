const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const config = require('../../config');
const dbService = require('../database');
const { parseJstDateTime, formatJst } = require('./format');

/* =====================================================================
 * 登録項目のインライン編集
 *
 * これまで登録内容を直すには「削除してもう一度 /vc_add」しか手が無く、
 * 誤字やpage_idの指定ミス、監視期間の延長のたびに検知履歴まで消えていた。
 * 一覧コマンド（/vc_list・/x_list・/user_list）にセレクトメニューを付け、
 *   一覧で項目を選ぶ → 現在値が入ったモーダルが開く → 保存 → 一覧がその場で更新
 * という流れで直せるようにする。
 *
 * 対象ごとの差分は下の EDITORS に閉じ込めてあり、
 * ルーティング・モーダル生成・保存後の再描画は共通コードで動く。
 * ===================================================================== */

// customId の区切り。キーワード等に現れうる文字は避ける
const SEP = '|';
const SELECT_PREFIX = 'edit';
const MODAL_PREFIX = 'editmodal';

// Discordの制限（超えるとAPIエラーで操作全体が落ちるため、生成時に必ず丸める）
const MAX_SELECT_OPTIONS = 25;
const MAX_OPTION_LABEL = 100;
const MAX_MODAL_FIELDS = 5;

function truncate(str, maxLen) {
  const s = str == null ? '' : String(str);
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** モーダルのテキスト入力は空文字で返ってくる。未入力を null に正規化する */
function nullIfBlank(value) {
  const trimmed = (value || '').trim();
  return trimmed ? trimmed : null;
}

/** 「有効/無効」系の自由入力を真偽値にする。判定できなければ null */
function parseEnabled(value) {
  const v = (value || '').trim().toLowerCase();
  if (['on', 'yes', 'y', 'true', '1', '有効', 'オン'].includes(v)) return true;
  if (['off', 'no', 'n', 'false', '0', '無効', 'オフ', '停止'].includes(v)) return false;
  return null;
}

/**
 * "2026-08-21 19:00 〜 2026-08-24 17:00" を開始/終了に分解する。
 * 空欄なら「常時（制限なし）」＝両方 null。
 * @returns {{ok: true, from: string|null, until: string|null}|{ok: false, message: string}}
 */
function parsePeriod(raw) {
  const input = (raw || '').trim();
  if (!input) return { ok: true, from: null, until: null };

  const [fromRaw = '', untilRaw = ''] = input.split(/[〜~]/).map((s) => s.trim());

  const from = fromRaw ? parseJstDateTime(fromRaw) : null;
  if (fromRaw && !from) {
    return { ok: false, message: `監視開始日時を読み取れませんでした: \`${fromRaw}\`（例: 2026-08-21 19:00）` };
  }
  const until = untilRaw ? parseJstDateTime(untilRaw) : null;
  if (untilRaw && !until) {
    return { ok: false, message: `監視終了日時を読み取れませんでした: \`${untilRaw}\`（例: 2026-08-24 17:00）` };
  }
  if (from && until && new Date(from) >= new Date(until)) {
    return { ok: false, message: '監視終了日時は開始日時より後に設定してください。' };
  }
  return { ok: true, from, until };
}

/** 変更前後を比べて「何がどう変わったか」の行を作る */
function diffLines(before, after, labels) {
  const show = (v) => {
    if (v === null || v === undefined || v === '') return '（なし）';
    if (v === true) return '有効';
    if (v === false) return '無効';
    return `\`${v}\``;
  };
  return Object.entries(labels)
    .filter(([key]) => before[key] !== after[key])
    .map(([key, label]) => `・${label}: ${show(before[key])} → ${show(after[key])}`);
}

/* ---------------------------------------------------------------------
 * 対象ごとの定義
 * ------------------------------------------------------------------- */

const EDITORS = {
  // ボカコレ / ランキング監視キーワード
  vc: {
    label: 'ボカコレ監視キーワード',
    placeholder: '編集するキーワードを選択…',
    loadAll: (guildId) => dbService.getVocacolleKeywords(guildId, true),
    loadOne: (guildId, key) => dbService.getVocacolleKeyword(guildId, Number(key)),
    keyOf: (row) => String(row.id),

    optionOf: (row) => ({
      label: truncate(`#${row.id} ${row.keyword}`, MAX_OPTION_LABEL),
      description: truncate(
        `${row.target === 'artist' ? 'アーティスト' : '曲名'} / page: ${row.page_id}${row.enabled ? '' : ' / 無効'}`,
        MAX_OPTION_LABEL
      ),
    }),

    // Discordのモーダルはテキスト入力5個までなので、動作に影響する5項目に絞っている
    // （メモは一覧に表示されるだけの項目なので編集対象から外した）
    fields: (row) => [
      { id: 'keyword', label: 'キーワード（完全一致）', style: TextInputStyle.Short, required: true, value: row.keyword, maxLength: 200 },
      { id: 'target', label: '対象（曲名 / アーティスト）', style: TextInputStyle.Short, required: true, value: row.target === 'artist' ? 'アーティスト' : '曲名', maxLength: 20 },
      { id: 'page_id', label: 'ページID（例: rookie）', style: TextInputStyle.Short, required: true, value: row.page_id, maxLength: 50 },
      {
        id: 'period', label: '監視期間（空欄で常時）', style: TextInputStyle.Short, required: false,
        value: row.active_from || row.active_until
          ? `${row.active_from ? formatJst(row.active_from) : ''} 〜 ${row.active_until ? formatJst(row.active_until) : ''}`.trim()
          : '',
        placeholder: '2026-08-21 19:00 〜 2026-08-24 17:00',
        maxLength: 100,
      },
      { id: 'enabled', label: '監視する（on / off）', style: TextInputStyle.Short, required: true, value: row.enabled ? 'on' : 'off', maxLength: 10 },
    ],

    async apply(guildId, row, values) {
      const keyword = nullIfBlank(values.keyword);
      if (!keyword) return { ok: false, message: 'キーワードは空にできません。' };

      const targetRaw = (values.target || '').trim().toLowerCase();
      const target = ['artist', 'アーティスト', 'アーティスト名'].includes(targetRaw) ? 'artist'
        : ['title', '曲名', 'タイトル'].includes(targetRaw) ? 'title'
          : null;
      if (!target) return { ok: false, message: '対象は「曲名」または「アーティスト」を指定してください。' };

      const pageId = nullIfBlank(values.page_id);
      if (!pageId) return { ok: false, message: 'ページIDは空にできません（既定値は rookie です）。' };

      const period = parsePeriod(values.period);
      if (!period.ok) return { ok: false, message: period.message };

      const enabled = parseEnabled(values.enabled);
      if (enabled === null) return { ok: false, message: '「監視する」には on または off を指定してください。' };

      const result = await dbService.updateVocacolleKeyword(guildId, row.id, {
        keyword, target, pageId, activeFrom: period.from, activeUntil: period.until, enabled,
      });

      if (!result.ok) {
        return {
          ok: false,
          message: result.reason === 'duplicate'
            ? `\`${keyword}\` は既に同じ対象・同じページ（\`${pageId}\`）で登録されています。`
            : result.reason === 'not_found'
              ? 'この登録は既に削除されているようです。'
              : '保存に失敗しました。ログを確認してください。',
        };
      }

      const labels = { keyword: 'キーワード', target: '対象', page_id: 'ページID', active_from: '監視開始', active_until: '監視終了', enabled: '監視' };
      const readable = (r) => ({ ...r, active_from: formatJst(r.active_from), active_until: formatJst(r.active_until) });
      return { ok: true, title: `#${row.id} を更新しました`, changes: diffLines(readable(row), readable(result.data), labels) };
    },

    async renderEmbed(guildId) {
      const keywords = await dbService.getVocacolleKeywords(guildId, true);
      // 「トグルが有効か」ではなく「実際に動く状態か」を出す（未設定の鯖で
      // 有効と表示すると、何も起きないことに気づけないため）
      const status = dbService.getGuildFeatureStatus(guildId);
      const watchStateLine = status.vocacolle.active
        ? '監視スケジュール: **稼働中**'
        : !status.vocacolle.enabled ? '監視スケジュール: **停止中**（/vc_toggle on で再開）'
          : !status.notifyChannel ? '監視スケジュール: **停止中**（通知先が未設定。/guild_setup で指定してください）'
            : '監視スケジュール: **停止中**（有効なキーワードがありません）';

      if (!keywords.length) {
        return new EmbedBuilder()
          .setTitle('ボカコレ監視キーワード (0件)')
          .setColor(parseInt(config.CHART_COLOR, 16))
          .setDescription(`${watchStateLine}\n監視キーワードは登録されていません。\`/vc_add\` で登録してください。`)
          .setFooter({ text: config.FOOTER_TEXT });
      }

      const vocacolle = require('../vocacolle');
      const now = new Date();
      const lines = keywords.map((k) => {
        const targetLabel = k.target === 'artist' ? 'アーティスト' : '曲名';
        const state = vocacolle.isActive(k, now) ? '有効' : (k.enabled ? '期間外' : '停止中');
        const period = (k.active_from || k.active_until)
          ? `${formatJst(k.active_from)} 〜 ${formatJst(k.active_until)}`
          : '常時';
        return `**#${k.id}** [${targetLabel}] \`${k.keyword}\` (page: \`${k.page_id}\`)\n　${state} / ${period}${k.note ? `\n　メモ: ${k.note}` : ''}`;
      });

      let desc = `${watchStateLine}\n\n${lines.join('\n')}`;
      if (desc.length > 4000) desc = `${desc.slice(0, 3900)}\n... (省略されました)`;

      return new EmbedBuilder()
        .setTitle(`ボカコレ監視キーワード (${keywords.length}件)`)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setDescription(desc)
        .setFooter({ text: config.FOOTER_TEXT });
    },
  },

  // X（旧Twitter）監視キーワード
  x: {
    label: 'X 監視キーワード',
    placeholder: '編集するキーワードを選択…',
    loadAll: async (guildId) => dbService.getTwitterKeywords(guildId, true),
    loadOne: async (guildId, key) => dbService.getTwitterKeyword(guildId, Number(key)),
    keyOf: (row) => String(row.id),

    optionOf: (row) => ({
      label: truncate(`#${row.id} ${row.query}`, MAX_OPTION_LABEL),
      description: truncate(row.note || (row.enabled ? '監視中' : '無効'), MAX_OPTION_LABEL),
    }),

    fields: (row) => [
      { id: 'query', label: '検索クエリ', style: TextInputStyle.Short, required: true, value: row.query, maxLength: 300 },
      { id: 'note', label: 'メモ（任意）', style: TextInputStyle.Short, required: false, value: row.note || '', maxLength: 200 },
      { id: 'enabled', label: '監視する（on / off）', style: TextInputStyle.Short, required: true, value: row.enabled ? 'on' : 'off', maxLength: 10 },
    ],

    async apply(guildId, row, values) {
      const query = nullIfBlank(values.query);
      if (!query) return { ok: false, message: '検索クエリは空にできません。' };

      const enabled = parseEnabled(values.enabled);
      if (enabled === null) return { ok: false, message: '「監視する」には on または off を指定してください。' };

      const result = dbService.updateTwitterKeyword(guildId, row.id, { query, note: nullIfBlank(values.note), enabled });
      if (!result.ok) {
        return {
          ok: false,
          message: result.reason === 'duplicate'
            ? `\`${query}\` は既に登録されています。`
            : result.reason === 'not_found'
              ? 'この登録は既に削除されているようです。'
              : '保存に失敗しました。ログを確認してください。',
        };
      }

      return {
        ok: true,
        title: `#${row.id} を更新しました`,
        changes: diffLines(row, result.data, { query: '検索クエリ', note: 'メモ', enabled: '監視' }),
      };
    },

    async renderEmbed(guildId) {
      const keywords = dbService.getTwitterKeywords(guildId, true);
      const status = dbService.getGuildFeatureStatus(guildId);
      const stateLine = !config.TWITTER_MONITOR.ENABLED
        ? '監視状態: **未セットアップ**（TWITTER_MONITOR_ENABLED=false。.envにTWITTER_CT0/TWITTER_AUTH_TOKENの設定が必要）'
        : status.twitter.active ? '監視スケジュール: **稼働中**'
          : !status.twitter.enabled ? '監視スケジュール: **停止中**（/x_toggle on で再開）'
            : !status.notifyChannel ? '監視スケジュール: **停止中**（通知先が未設定。/guild_setup で指定してください）'
              : '監視スケジュール: **停止中**（有効なキーワードがありません）';

      if (!keywords.length) {
        return new EmbedBuilder()
          .setTitle('X 監視キーワード (0件)')
          .setColor(0x1d9bf0)
          .setDescription(`${stateLine}\n監視キーワードは登録されていません。\`/x_add\` で登録してください。`)
          .setFooter({ text: config.FOOTER_TEXT });
      }

      const lines = keywords.map((k) => `**#${k.id}** \`${k.query}\`${k.enabled ? '' : '（無効）'}${k.note ? ` — ${k.note}` : ''}`);
      let desc = `${stateLine}\n\n${lines.join('\n')}`;
      if (desc.length > 4000) desc = `${desc.slice(0, 3900)}\n... (省略されました)`;

      return new EmbedBuilder()
        .setTitle(`X 監視キーワード (${keywords.length}件)`)
        .setColor(0x1d9bf0)
        .setDescription(desc)
        .setFooter({ text: config.FOOTER_TEXT });
    },
  },

  // 監視対象のニコニコユーザー
  user: {
    label: '監視ニコニコユーザー',
    placeholder: '編集するユーザーを選択…',
    loadAll: async (guildId) => dbService.getNicoUsersDetailed(guildId),
    loadOne: async (guildId, key) => dbService.getNicoUser(guildId, key),
    keyOf: (row) => String(row.user_id),

    optionOf: (row) => ({
      label: truncate(row.user_id, MAX_OPTION_LABEL),
      description: truncate(row.label || 'ラベルなし', MAX_OPTION_LABEL),
    }),

    fields: (row) => [
      { id: 'user_id', label: 'ユーザーID（数字）', style: TextInputStyle.Short, required: true, value: row.user_id, maxLength: 30 },
      { id: 'label', label: '識別用のメモ（任意）', style: TextInputStyle.Short, required: false, value: row.label || '', maxLength: 100 },
    ],

    async apply(guildId, row, values) {
      const userId = nullIfBlank(values.user_id);
      if (!userId || !/^\d+$/.test(userId)) {
        return { ok: false, message: 'ユーザーIDは数字のみで指定してください（例: 143305795）。' };
      }

      const result = dbService.updateNicoUser(guildId, row.user_id, { userId, label: nullIfBlank(values.label) });
      if (!result.ok) {
        return {
          ok: false,
          message: result.reason === 'duplicate'
            ? `\`${userId}\` は既に登録されています。`
            : result.reason === 'not_found'
              ? 'この登録は既に削除されているようです。'
              : '保存に失敗しました。ログを確認してください。',
        };
      }

      return {
        ok: true,
        title: `\`${row.user_id}\` を更新しました`,
        changes: diffLines(row, result.data, { user_id: 'ユーザーID', label: 'メモ' }),
      };
    },

    async renderEmbed(guildId) {
      const users = dbService.getNicoUsersDetailed(guildId);
      const lines = users.map((u) => `• \`${u.user_id}\`${u.label ? ` — ${u.label}` : ''}`);

      return new EmbedBuilder()
        .setTitle(`監視中のニコニコユーザー (${users.length}人)`)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setDescription(
          lines.join('\n') ||
          '登録されていません。**このサーバーでは投稿者の新着監視は動作しません。**'
        )
        .addFields({
          name: 'ユーザーを追加するには',
          value: '`/user_add user_id:143305795 label:任意のメモ`\nここに登録した投稿者の新着動画だけを検知します。',
          inline: false,
        })
        .setFooter({ text: config.FOOTER_TEXT });
    },
  },
};

/* ---------------------------------------------------------------------
 * 共通処理（対象の種類によらず同じ動き）
 * ------------------------------------------------------------------- */

/**
 * 一覧メッセージ（Embed＋編集用セレクトメニュー）を組み立てる。
 *
 * @param {string} kind EDITORS のキー
 * @param {string} invokerId コマンドを実行した人のDiscordユーザーID。
 *   セレクトメニューはメッセージを見た人なら誰でも押せてしまうため、
 *   customIdに実行者を埋めて本人以外の操作を弾く。
 */
async function buildListMessage(kind, guildId, invokerId) {
  const editor = EDITORS[kind];
  const embed = await editor.renderEmbed(guildId);
  const rows = await editor.loadAll(guildId);

  if (!rows.length) return { embeds: [embed], components: [] };

  const options = rows.slice(0, MAX_SELECT_OPTIONS).map((row) => ({
    ...editor.optionOf(row),
    value: editor.keyOf(row),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId([SELECT_PREFIX, kind, invokerId].join(SEP))
    .setPlaceholder(editor.placeholder)
    .addOptions(options);

  if (rows.length > MAX_SELECT_OPTIONS) {
    embed.setFooter({ text: `${config.FOOTER_TEXT} ・ 編集メニューには先頭${MAX_SELECT_OPTIONS}件のみ表示されます` });
  }

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

/** このcustomIdが編集セレクトメニューのものか */
function isEditSelect(customId) {
  return typeof customId === 'string' && customId.startsWith(`${SELECT_PREFIX}${SEP}`);
}
/** このcustomIdが編集モーダルのものか */
function isEditModal(customId) {
  return typeof customId === 'string' && customId.startsWith(`${MODAL_PREFIX}${SEP}`);
}

/**
 * 一覧のセレクトメニューで項目が選ばれたとき: 現在値を入れたモーダルを開く。
 * showModal は「そのインタラクションへの最初の応答」でなければならないため、
 * この関数の中で deferReply/reply を先に呼んではいけない。
 */
async function handleEditSelect(interaction) {
  const [, kind, invokerId] = interaction.customId.split(SEP);
  const editor = EDITORS[kind];
  if (!editor) return;
  const guildId = interaction.guildId;

  if (invokerId && interaction.user.id !== invokerId) {
    return await interaction.reply({
      content: 'この一覧は他の人が開いたものです。ご自身で一覧コマンドを実行してから編集してください。',
      ephemeral: true,
    });
  }

  const key = interaction.values[0];
  const row = await editor.loadOne(guildId, key);
  if (!row) {
    return await interaction.reply({ content: 'この登録は既に削除されているようです。一覧を開き直してください。', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId([MODAL_PREFIX, kind, key].join(SEP))
    .setTitle(truncate(`${editor.label} を編集`, 45));

  for (const field of editor.fields(row).slice(0, MAX_MODAL_FIELDS)) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(truncate(field.label, 45))
      .setStyle(field.style)
      .setRequired(!!field.required);
    // 空文字を setValue すると「未入力」ではなくエラーになる版があるため、値がある時だけ設定する
    if (field.value) input.setValue(String(field.value));
    if (field.placeholder) input.setPlaceholder(truncate(field.placeholder, 100));
    if (field.maxLength) input.setMaxLength(field.maxLength);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  await interaction.showModal(modal);
}

/**
 * モーダルが送信されたとき: 検証して保存し、元の一覧メッセージを最新の内容に差し替える。
 *
 * 一覧の更新には interaction.update() を使う。一覧メッセージはスラッシュコマンドの
 * 応答（Webhookメッセージ）なので、Message#edit() では編集できないことがあるため。
 * update() が使えるのはメッセージ上のコンポーネントから開いたモーダルのときだけなので、
 * そうでない場合は本人向けの応答だけ返す。
 */
async function handleEditModal(interaction) {
  const [, kind, key] = interaction.customId.split(SEP);
  const editor = EDITORS[kind];
  if (!editor) return;
  const guildId = interaction.guildId;

  const fromMessage = typeof interaction.isFromMessage === 'function' && interaction.isFromMessage();

  const row = await editor.loadOne(guildId, key);
  if (!row) {
    return await interaction.reply({
      content: 'この登録は既に削除されているようです。一覧を開き直してください。',
      ephemeral: true,
    });
  }

  const values = {};
  for (const field of editor.fields(row)) {
    values[field.id] = interaction.fields.getTextInputValue(field.id);
  }

  const result = await editor.apply(guildId, row, values);

  // 失敗時は一覧を触らず、本人にだけ理由を返す（入力し直せるようにするため）
  if (!result.ok) {
    return await interaction.reply({ content: `保存できませんでした。\n${result.message}`, ephemeral: true });
  }

  const summary = result.changes && result.changes.length
    ? `${result.title}\n${result.changes.join('\n')}`
    : `${result.title}\n（内容に変更はありませんでした）`;

  if (fromMessage) {
    // 一覧をその場で描き直してから、本人にだけ変更内容を知らせる
    await interaction.update(await buildListMessage(kind, guildId, interaction.user.id));
    await interaction.followUp({ content: summary, ephemeral: true });
    return;
  }

  await interaction.reply({ content: summary, ephemeral: true });
}

module.exports = {
  EDITORS,
  buildListMessage,
  isEditSelect,
  isEditModal,
  handleEditSelect,
  handleEditModal,
  // テスト・再利用のために内部ヘルパーも公開する
  parsePeriod,
  parseEnabled,
  diffLines,
};
