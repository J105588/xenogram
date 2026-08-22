const { EmbedBuilder } = require('discord.js');
const niconico = require('../niconico');
const supabaseService = require('../supabase');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
const { markRun } = require('./status');

// 急上昇検知の連続通知を防ぐクールダウン（動画IDごとに最後に通知した時刻を覚えておく）。
// プロセス内メモリのみで保持するため、再起動すると各動画のクールダウンはリセットされる
const spikeLastNotifiedAt = new Map();

/**
 * 直近1時間の再生数の伸びが閾値を超えていたら「急上昇中」として通知する。
 * 同じ動画への連続通知は SPIKE_DETECTION.COOLDOWN_HOURS の間は抑制する。
 */
async function checkSpike(video, oldViews, newViews) {
  if (!config.SPIKE_DETECTION.ENABLED) return;
  const growth = newViews - oldViews;
  if (growth < config.SPIKE_DETECTION.VIEW_THRESHOLD_PER_HOUR) return;

  const lastNotified = spikeLastNotifiedAt.get(video.id);
  const cooldownMs = config.SPIKE_DETECTION.COOLDOWN_HOURS * 60 * 60 * 1000;
  if (lastNotified && Date.now() - lastNotified < cooldownMs) return;

  spikeLastNotifiedAt.set(video.id, Date.now());

  await discordService.sendNotification(
    new EmbedBuilder()
      .setTitle('🔥 急上昇中！')
      .setDescription(`**${video.title}** がこの1時間で **+${growth.toLocaleString()}再生** 伸びています！`)
      .setColor(0xff6b35)
      .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
      .setThumbnail(video.thumbnail_url)
      .setFooter({ text: config.FOOTER_TEXT })
      .setTimestamp()
  );
}

/**
 * 【1時間ごとに実行】新着動画の検知とマイルストーンチェック
 */
async function updateVideoList() {
  console.log("Running hourly updateVideoList...");

  // 監視対象ユーザーの全投稿動画を一括取得する（1回のAPI呼び出し）。
  // 新着検知にも、後段のマイルストーンチェックにも同じデータを使い回す。
  const allUserVideos = await niconico.fetchAllUserVideos();
  const bulkById = new Map(allUserVideos.map(v => [v.id, v]));

  // 1. 新着動画をチェック（投稿日時が古い順に処理することで、重複防止と投稿順の整合性を保つ）
  const items = allUserVideos.map(v => ({ link: `https://www.nicovideo.jp/watch/${v.id}`, title: v.title }));
  const reversedItems = [...items].reverse();

  for (const item of reversedItems) {
    // URLからIDを抽出
    const link = item.link;
    const videoId = link.split("/").pop().split("?")[0].trim();

    const exists = await supabaseService.hasVideo(videoId);
    if (!exists) {
      console.log(`New video detected: ${videoId}`);
      // 詳細データを取得（タグ情報は一括APIに無いため、新着1件だけは個別APIで取る）
      const apiData = await niconico.fetchNicoData(videoId);
      if (apiData) {
        // 1. 動画マスター情報の追加 (投稿日時を含める)
        await supabaseService.addVideo(videoId, apiData.title, apiData.tags, apiData.thumbnail, apiData.publishedAt);
        // 2. 初回の初期統計データの登録
        await supabaseService.recordStats(videoId, apiData.view, apiData.comment, apiData.mylist, apiData.like);

        const embed = new EmbedBuilder()
          .setTitle("🎉 New Upload Detected!")
          .setDescription(`**${apiData.title}**\n${link}`)
          .setColor(0x2ecc71)
          .setThumbnail(apiData.thumbnail)
          .setFooter({ text: config.FOOTER_TEXT })
          .setTimestamp();

        await discordService.sendNotification(embed);
      }
    }
  }

  // 2. マイルストーンチェック（全動画の現在の数値をチェックし、前回記録時と比べてキリ番を跨いでいたら通知）
  const videos = await supabaseService.getAllVideos();
  for (const video of videos) {
    try {
      // 監視対象ユーザー自身の動画なら一括取得済みのデータを使い、
      // /add で追加された他ユーザーの動画（一括データに無い）だけ個別APIにフォールバックする
      const bulkData = bulkById.get(video.id);
      const apiData = bulkData
        ? { view: bulkData.view, comment: bulkData.comment, mylist: bulkData.mylist, like: bulkData.like, thumbnail: bulkData.thumbnail }
        : await niconico.fetchNicoData(video.id);
      if (!apiData) continue;

      const latestDbStats = await supabaseService.getLatestStats(video.id);
      if (latestDbStats) {
        const statsToCheck = [
          { name: '再生', oldVal: latestDbStats.views, newVal: apiData.view, color: 0x3498db },
          { name: 'いいね', oldVal: latestDbStats.likes, newVal: apiData.like, color: 0xe74c3c },
          { name: 'マイリスト', oldVal: latestDbStats.mylists, newVal: apiData.mylist, color: 0xf1c40f },
          { name: 'コメント', oldVal: latestDbStats.comments, newVal: apiData.comment, color: 0x9b59b6 }
        ];

        for (const stat of statsToCheck) {
          const crossed = utils.checkMilestone(stat.oldVal, stat.newVal, config.MILESTONE_STEP);
          if (crossed) {
            await discordService.sendNotification(
              new EmbedBuilder()
                .setTitle(`🎊 Milestone Reached!`)
                .setDescription(`**${video.title}** が **${crossed.toLocaleString()}** ${stat.name}を突破しました！`)
                .setColor(stat.color)
                .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
                .setThumbnail(apiData.thumbnail)
            );
          }
        }

        // 急上昇検知（再生数の伸びだけを見る）
        await checkSpike(video, latestDbStats.views, apiData.view);
      }

      // タグやサムネが更新されていればDBも更新。
      // 一括APIにはタグが含まれないため、そのときは既存のタグ値をそのまま使い、
      // 「タグが変わった」と誤検知して意味のない上書きをしないようにする。
      const newTags = apiData.tags !== undefined ? apiData.tags : video.tags;
      if (video.tags !== newTags || video.thumbnail_url !== apiData.thumbnail) {
        await supabaseService.updateVideoInfo(video.id, newTags, apiData.thumbnail);
      }

      // 重要: 現在の数値をDBに記録して最新スナップショットとして保存する
      await supabaseService.recordStats(video.id, apiData.view, apiData.comment, apiData.mylist, apiData.like);
    } catch (videoUpdateErr) {
      console.error(`❌ Error updating video ${video.id} in background schedule:`, videoUpdateErr);
    }
  }

  // ステータスの更新 (監視動画数)
  if (discordService.client.user) {
    discordService.client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
  }

  markRun('updateVideoList');
}

module.exports = { updateVideoList };
