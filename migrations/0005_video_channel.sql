-- 通常の通知（Bot起動/停止・エラー等）と動画監視（新着・キリ番・急上昇・
-- デイリー/週次レポート）の通知先を、ボカコレ・Xと同様に別チャンネルへ
-- 分けられるようにする。未設定の間は resolveChannelId() が notify_channel_id に
-- フォールバックするため、これまで通り何も設定しなければ挙動は変わらない。
ALTER TABLE guilds ADD COLUMN video_channel_id TEXT;
