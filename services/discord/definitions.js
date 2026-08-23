const { REST, Routes, PermissionFlagsBits } = require('discord.js');
const config = require('../../config');

// 【管理者】表記のコマンドは default_member_permissions で実際に権限を絞る
// （Discord側で非管理者からは実行はおろか一覧にも出なくなる）。
// 説明文の表記だけで、実際の権限チェックが存在しなかった状態を修正するためのもの。
//
// dm_permission: false も併せて指定する。default_member_permissions は
// 「サーバーメンバーの権限」に基づく判定のため、DM（サーバー外）にはそもそも
// 適用できない。dm_permission を明示的にfalseにしないと、グローバルコマンド
// 登録時（DISCORD_GUILD_ID未設定時）はDM経由で誰でも実行できてしまう抜け道が残る。
const ADMIN_ONLY = {
  default_member_permissions: PermissionFlagsBits.Administrator.toString(),
  dm_permission: false,
};

// スラッシュコマンドの定義。/help の一覧表示にもそのまま使う。
const commands = [
  { name: 'help', description: '利用可能な全コマンドのリストを表示します。' },
  { name: 'ping', description: 'Botの稼働状況と応答速度を確認します。' },
  {
    name: 'stats',
    description: '指定した動画の最新データとグラフを表示します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true, autocomplete: true }]
  },
  { name: 'list', description: '現在監視中の全動画のリストを表示します。' },
  {
    name: 'add',
    description: '手動で特定の動画を監視対象に追加します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true }]
  },
  {
    name: 'remove',
    description: '指定した動画を監視リストから除外します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true, autocomplete: true }]
  },
  {
    name: 'compare',
    description: '2つの動画のステータスを比較します。',
    options: [
      { name: 'video_id1', type: 3, description: '動画ID 1', required: true, autocomplete: true },
      { name: 'video_id2', type: 3, description: '動画ID 2', required: true, autocomplete: true }
    ]
  },
  { name: 'force_update', description: '【管理者】1時間に1回の定期更新を手動で実行します。', ...ADMIN_ONLY },
  { name: 'daily_report', description: '【管理者】毎朝のデイリーレポートを手動で実行します。', ...ADMIN_ONLY },
  { name: 'restart', description: '【管理者】Botプロセスを再起動します（PM2運用時のみ自動復帰）。', ...ADMIN_ONLY },
  {
    name: 'ranking',
    description: '監視中動画のランキングを表示します。',
    options: [{
      name: 'type', type: 3, description: 'ランキングの指標', required: true,
      choices: [
        { name: '再生数', value: 'views' },
        { name: 'いいね', value: 'likes' },
        { name: 'マイリスト', value: 'mylists' },
        { name: 'コメント', value: 'comments' }
      ]
    }]
  },
  { name: 'growth', description: '直近24時間で最も伸びている動画のトップを表示します。' },
  { name: 'upcoming', description: 'もうすぐ次のキリ番（マイルストーン）に到達しそうな動画を表示します。' },
  { name: 'export', description: '記録されている統計データをCSVファイルとしてエクスポートします。' },
  {
    name: 'vc_add',
    description: 'ランキング監視キーワードを追加します（曲名・アーティスト名の完全一致）。',
    options: [
      { name: 'keyword', type: 3, description: '完全一致させる曲名またはアーティスト名', required: true },
      {
        name: 'target', type: 3, description: '照合する対象', required: true,
        choices: [
          { name: '曲名', value: 'title' },
          { name: 'アーティスト名', value: 'artist' }
        ]
      },
      { name: 'active_from', type: 3, description: '監視開始日時 (例: 2026-08-21 19:00)', required: false },
      { name: 'active_until', type: 3, description: '監視終了日時 (例: 2026-08-24 17:00)', required: false },
      { name: 'page_id', type: 3, description: '対象ページのID（未指定なら rookie。複数ページ監視時に使い分ける）', required: false },
      { name: 'note', type: 3, description: 'メモ', required: false }
    ]
  },
  { name: 'vc_list', description: 'ボカコレ監視キーワードの一覧を表示します（一覧から各項目をその場で編集できます）。' },
  {
    name: 'vc_remove',
    description: 'ボカコレ監視キーワードを削除します。',
    options: [{ name: 'id', type: 4, description: '/vc_list で表示されるID', required: true, autocomplete: true }]
  },
  { name: 'vc_check', description: '【管理者】ボカコレ監視を今すぐ1回実行します。', ...ADMIN_ONLY },
  {
    name: 'vc_toggle',
    description: '【管理者】ボカコレ監視の有効/無効を切り替えます。',
    options: [{
      name: 'state', type: 3, description: '設定する状態', required: true,
      choices: [
        { name: '有効にする (ON)', value: 'on' },
        { name: '無効にする (OFF)', value: 'off' }
      ]
    }],
    ...ADMIN_ONLY
  },
  { name: 'status', description: 'Botの稼働状況（起動時間・メモリ・各定期ジョブの最終実行）を表示します。' },
  {
    name: 'user_add',
    description: '【管理者】監視対象のニコニコユーザーIDを追加します（複数ユーザー監視）。',
    options: [
      { name: 'user_id', type: 3, description: 'ニコニコのユーザーID（数字）', required: true },
      { name: 'label', type: 3, description: '識別用のメモ（任意）', required: false }
    ],
    ...ADMIN_ONLY
  },
  {
    name: 'user_remove',
    description: '【管理者】監視対象のニコニコユーザーIDを削除します。',
    options: [{ name: 'user_id', type: 3, description: 'ニコニコのユーザーID', required: true, autocomplete: true }],
    ...ADMIN_ONLY
  },
  { name: 'user_list', description: '現在監視中のニコニコユーザーID一覧を表示します（一覧から各項目をその場で編集できます）。' },
  {
    name: 'set_milestone',
    description: '【管理者】マイルストーン（キリ番）の判定単位を変更します。',
    options: [{ name: 'step', type: 4, description: '例: 100, 1000', required: true }],
    ...ADMIN_ONLY
  },
  {
    name: 'set_spike',
    description: '【管理者】急上昇検知のしきい値を変更します。',
    options: [
      { name: 'threshold', type: 4, description: '1時間あたりこの再生数以上で急上昇と判定', required: true },
      { name: 'cooldown_hours', type: 4, description: '同じ動画への再通知までの間隔（時間）', required: false }
    ],
    ...ADMIN_ONLY
  },
  {
    name: 'set_rank_threshold',
    description: '【管理者】ボカコレ順位変動通知のしきい値を変更します。',
    options: [{ name: 'positions', type: 4, description: 'この順位差以上動いたら通知', required: true }],
    ...ADMIN_ONLY
  },
  {
    name: 'set_schedule',
    description: '【管理者】各定期ジョブの実行時刻を変更します（例: 5分 / 7時30分 / 日 21時。cron式も可）。',
    options: [
      {
        name: 'job', type: 3, description: '対象ジョブ', required: true,
        choices: [
          { name: '毎時 新着/キリ番/急上昇チェック', value: 'update_video_list' },
          { name: 'デイリーレポート', value: 'daily_report' },
          { name: 'ボカコレ/ランキング監視', value: 'vocacolle_watch' },
          { name: '週次まとめレポート', value: 'weekly_report' }
          // 'X(Twitter) キーワード監視' (twitter_watch) は下の X_COMMANDS ブロックで
          // config.TWITTER_MONITOR.ENABLED の時だけ動的に追加する
        ]
      },
      {
        name: 'cron', type: 3,
        description: '実行時刻（例: 5分 / 7時30分 / 日 21時）。cron式もそのまま使えます',
        required: true, autocomplete: true
      }
    ],
    ...ADMIN_ONLY
  },
  { name: 'settings', description: '現在のマイルストーン・急上昇・実行スケジュール等の設定値を一覧表示します。' },
  {
    name: 'guild_setup',
    description: '【管理者】このサーバーの通知先チャンネルを設定します（未設定だと通知は届きません）。',
    options: [
      { name: 'channel', type: 7, description: '通知先チャンネル（省略すると解除）', required: false },
      {
        name: 'kind', type: 3, description: '設定する通知の種類（省略時は通常の通知）', required: false,
        choices: [
          { name: '通常の通知（レポート・新着・キリ番）', value: 'notify' },
          { name: 'ボカコレ/ランキング監視', value: 'vocacolle' },
          { name: 'X(Twitter)監視', value: 'twitter' }
        ]
      }
    ],
    ...ADMIN_ONLY
  },
  {
    name: 'guild_adopt',
    description: '【管理者】サーバー未指定で移行された旧データを、このサーバーに引き継ぎます。',
    ...ADMIN_ONLY
  },
  {
    name: 'logs',
    description: '【管理者】直近のBotログ（実行ログ・エラーログ）を表示します。',
    options: [
      { name: 'lines', type: 4, description: '取得する行数（既定40、最大300）', required: false },
      {
        name: 'type', type: 3, description: '表示するログの種類', required: false,
        choices: [
          { name: 'すべて', value: 'all' },
          { name: 'エラーのみ', value: 'error' }
        ]
      }
    ],
    ...ADMIN_ONLY
  },
];

// X（旧Twitter）監視コマンド群。
// 検索機能がX側のbot対策未対応で動かないため一時的に隠している。TWITTER_MONITOR_ENABLED=true
// にするだけで、コマンド登録・/help・/status・/set_scheduleの選択肢すべてに自動的に復活する
// （config.TWITTER_MONITOR.ENABLED を唯一の判定材料にして、表に出る経路を一箇所で制御している）。
const X_COMMANDS = [
  {
    name: 'x_add',
    description: 'X（旧Twitter）の監視キーワード（検索クエリ）を追加します（読み取り専用・投稿はしません）。',
    options: [
      { name: 'query', type: 3, description: '検索クエリ（例: 曲名やアーティスト名）', required: true },
      { name: 'note', type: 3, description: 'メモ', required: false }
    ]
  },
  { name: 'x_list', description: 'X監視キーワードの一覧を表示します（一覧から各項目をその場で編集できます）。' },
  {
    name: 'x_remove',
    description: 'X監視キーワードを削除します。',
    options: [{ name: 'id', type: 4, description: '/x_list で表示されるID', required: true, autocomplete: true }]
  },
  { name: 'x_check', description: '【管理者】X監視を今すぐ1回実行します。', ...ADMIN_ONLY },
  {
    name: 'x_toggle',
    description: '【管理者】X監視の有効/無効を切り替えます。',
    options: [{
      name: 'state', type: 3, description: '設定する状態', required: true,
      choices: [
        { name: '有効にする (ON)', value: 'on' },
        { name: '無効にする (OFF)', value: 'off' }
      ]
    }],
    ...ADMIN_ONLY
  },
];

if (config.TWITTER_MONITOR.ENABLED) {
  commands.push(...X_COMMANDS);

  const setScheduleCmd = commands.find((c) => c.name === 'set_schedule');
  setScheduleCmd.options[0].choices.push({ name: 'X(Twitter) キーワード監視', value: 'twitter_watch' });
}

async function registerCommands() {
  if (!config.DISCORD.TOKEN || !config.DISCORD.CLIENT_ID) return;
  const rest = new REST({ version: '10' }).setToken(config.DISCORD.TOKEN);
  try {
    console.log('Started refreshing application (/) commands.');
    if (config.DISCORD.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(config.DISCORD.CLIENT_ID, config.DISCORD.GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(config.DISCORD.CLIENT_ID), { body: commands });
    }
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

module.exports = { commands, registerCommands };
