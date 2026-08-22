const { REST, Routes } = require('discord.js');
const config = require('../../config');

// スラッシュコマンドの定義。/help の一覧表示にもそのまま使う。
const commands = [
  { name: 'help', description: '利用可能な全コマンドのリストを表示します。' },
  { name: 'ping', description: 'Botの稼働状況と応答速度を確認します。' },
  {
    name: 'stats',
    description: '指定した動画の最新データとグラフを表示します。',
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true }]
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
    options: [{ name: 'video_id', type: 3, description: '動画ID (例: sm1234567)', required: true }]
  },
  {
    name: 'compare',
    description: '2つの動画のステータスを比較します。',
    options: [
      { name: 'video_id1', type: 3, description: '動画ID 1', required: true },
      { name: 'video_id2', type: 3, description: '動画ID 2', required: true }
    ]
  },
  { name: 'force_update', description: '【管理者】1時間に1回の定期更新を手動で実行します。' },
  { name: 'daily_report', description: '【管理者】毎朝のデイリーレポートを手動で実行します。' },
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
  { name: 'vc_list', description: 'ボカコレ監視キーワードの一覧を表示します。' },
  {
    name: 'vc_remove',
    description: 'ボカコレ監視キーワードを削除します。',
    options: [{ name: 'id', type: 4, description: '/vc_list で表示されるID', required: true }]
  },
  { name: 'vc_check', description: '【管理者】ボカコレ監視を今すぐ1回実行します。' },
  {
    name: 'vc_toggle',
    description: '【管理者】ボカコレ監視の有効/無効を切り替えます。',
    options: [{
      name: 'state', type: 3, description: '設定する状態', required: true,
      choices: [
        { name: '有効にする (ON)', value: 'on' },
        { name: '無効にする (OFF)', value: 'off' }
      ]
    }]
  },
  { name: 'status', description: 'Botの稼働状況（起動時間・メモリ・各定期ジョブの最終実行）を表示します。' },
  {
    name: 'user_add',
    description: '【管理者】監視対象のニコニコユーザーIDを追加します（複数ユーザー監視）。',
    options: [
      { name: 'user_id', type: 3, description: 'ニコニコのユーザーID（数字）', required: true },
      { name: 'label', type: 3, description: '識別用のメモ（任意）', required: false }
    ]
  },
  {
    name: 'user_remove',
    description: '【管理者】監視対象のニコニコユーザーIDを削除します。',
    options: [{ name: 'user_id', type: 3, description: 'ニコニコのユーザーID', required: true }]
  },
  { name: 'user_list', description: '現在監視中のニコニコユーザーID一覧を表示します。' },
  {
    name: 'set_milestone',
    description: '【管理者】マイルストーン（キリ番）の判定単位を変更します。',
    options: [{ name: 'step', type: 4, description: '例: 100, 1000', required: true }]
  },
  {
    name: 'set_spike',
    description: '【管理者】急上昇検知のしきい値を変更します。',
    options: [
      { name: 'threshold', type: 4, description: '1時間あたりこの再生数以上で急上昇と判定', required: true },
      { name: 'cooldown_hours', type: 4, description: '同じ動画への再通知までの間隔（時間）', required: false }
    ]
  },
  {
    name: 'set_rank_threshold',
    description: '【管理者】ボカコレ順位変動通知のしきい値を変更します。',
    options: [{ name: 'positions', type: 4, description: 'この順位差以上動いたら通知', required: true }]
  },
  {
    name: 'set_schedule',
    description: '【管理者】各定期ジョブの実行時刻（cron式）を変更します。',
    options: [
      {
        name: 'job', type: 3, description: '対象ジョブ', required: true,
        choices: [
          { name: '毎時 新着/キリ番/急上昇チェック', value: 'update_video_list' },
          { name: 'デイリーレポート', value: 'daily_report' },
          { name: 'ボカコレ/ランキング監視', value: 'vocacolle_watch' },
          { name: '週次まとめレポート', value: 'weekly_report' }
        ]
      },
      { name: 'cron', type: 3, description: 'cron式 (例: "5 * * * *" = 毎時5分)', required: true }
    ]
  },
  { name: 'settings', description: '現在のマイルストーン・急上昇・実行スケジュール等の設定値を一覧表示します。' }
];

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
