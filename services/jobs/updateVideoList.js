const { EmbedBuilder } = require('discord.js');
const niconico = require('../niconico');
const dbService = require('../database');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
const { markRun } = require('./status');
const { withSingleFlight } = require('../singleFlight');

// 急上昇検知の連続通知を防ぐクールダウン（鯖×動画ごとに最後に通知した時刻を覚えておく）。
// プロセス内メモリのみで保持するため、再起動すると各動画のクールダウンはリセットされる
const spikeLastNotifiedAt = new Map();

// 実行間隔が極端に短い場合（例: /set_schedule で1分間隔にした等）に、
// わずかな伸びが「1時間換算」で大きく水増しされて誤検知しないようにする下限
const MIN_SPIKE_INTERVAL_HOURS = 5 / 60; // 5分

/**
 * 直近の判定時点からの再生数の伸びを「1時間あたり」に正規化して閾値と比較し、
 * 超えていれば「急上昇中」として通知する。
 * update_video_list の実行間隔は /set_schedule で自由に変更できるため、
 * 単純な前回比ではなく実際の経過時間で正規化しないと、間隔を短くすると
 * 過小評価に、長くすると過大評価（＝毎回誤検知）になってしまう。
 * 同じ動画への連続通知は spike_cooldown_hours 設定の間は抑制する。
 * 閾値・クールダウンは /set_spike で鯖ごとに変更可能。
 */
async function checkSpike(guildId, video, previousState, newViews) {
  if (!config.SPIKE_DETECTION.ENABLED) return;
  const threshold = dbService.getSetting(guildId, 'spike_view_threshold_per_hour');
  const cooldownHours = dbService.getSetting(guildId, 'spike_cooldown_hours');

  const growth = newViews - previousState.views;
  if (growth <= 0) return;

  const elapsedHours = Math.max(
    MIN_SPIKE_INTERVAL_HOURS,
    (Date.now() - new Date(previousState.checked_at).getTime()) / (60 * 60 * 1000)
  );
  const hourlyRate = growth / elapsedHours;
  if (hourlyRate < threshold) return;

  const cooldownKey = `${guildId}:${video.id}`;
  const lastNotified = spikeLastNotifiedAt.get(cooldownKey);
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (lastNotified && Date.now() - lastNotified < cooldownMs) return;

  spikeLastNotifiedAt.set(cooldownKey, Date.now());

  const elapsedMinutes = Math.round(elapsedHours * 60);
  await discordService.sendNotification(
    guildId,
    new EmbedBuilder()
      .setTitle('🔥 急上昇中！')
      .setDescription(
        `**${utils.truncate(video.title, 200)}** が直近${elapsedMinutes}分で **+${growth.toLocaleString()}再生** 伸びています！` +
        `\n（1時間あたり換算: 約${Math.round(hourlyRate).toLocaleString()}再生）`
      )
      .setColor(0xff6b35)
      .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
      .setThumbnail(video.thumbnail_url)
      .setFooter({ text: config.FOOTER_TEXT })
      .setTimestamp(),
    'video'
  );
}

/**
 * 【1時間ごとに実行】新着動画の検知とマイルストーンチェック。
 * cronの自動実行と /force_update による手動実行が重なっても二重処理
 * （新着の二重通知・統計の二重記録）にならないよう、鯖ごとに常に1本だけ走らせる。
 */
async function updateVideoList(guildId) {
  const outcome = await withSingleFlight(`updateVideoList:${guildId}`, () => updateVideoListInner(guildId));
  if (!outcome.ok) {
    console.warn(`[UPDATE] 前回の updateVideoList がまだ完了していないため、今回はスキップします (guild: ${guildId})`);
    return { skipped: 'already_running' };
  }
  return outcome.result;
}

async function updateVideoListInner(guildId) {
  // 何も登録されていないサーバーでは一切動かない（Botを入れただけの鯖が
  // 勝手にAPIを叩いたり、身に覚えのない通知を出したりしないようにするため）。
  const status = dbService.getGuildFeatureStatus(guildId);
  if (!status.video.active) {
    console.log(
      `[UPDATE] 未設定のためスキップします (guild: ${guildId}) ` +
      `— 通知先:${status.video.channel ? 'あり' : 'なし'} / 監視ユーザー:${status.video.users}件 / 個別登録動画:${status.video.videos}件`
    );
    return { skipped: 'not_configured' };
  }

  console.log(`Running hourly updateVideoList... (guild: ${guildId})`);

  // その鯖が監視対象にしているユーザーの全投稿動画を一括取得する（1回のAPI呼び出し）。
  // 新着検知にも、後段のマイルストーンチェックにも同じデータを使い回す。
  const allUserVideos = await niconico.fetchAllUserVideos(guildId);
  const bulkById = new Map(allUserVideos.map(v => [v.id, v]));

  // 1. 新着動画をチェック（投稿日時が古い順に処理することで、重複防止と投稿順の整合性を保つ）
  const reversedItems = [...allUserVideos].reverse();

  for (const item of reversedItems) {
    const videoId = item.id;
    const link = `https://www.nicovideo.jp/watch/${videoId}`;

    const exists = await dbService.hasVideo(guildId, videoId);
    if (!exists) {
      console.log(`New video detected: ${videoId} (guild: ${guildId})`);
      // 詳細データを取得（タグ情報は一括APIに無いため、新着1件だけは個別APIで取る）
      const apiData = await niconico.fetchNicoData(videoId);
      if (apiData) {
        // 1. 動画マスター情報 ＋ この鯖の監視リストへの追加
        await dbService.addVideo(guildId, videoId, apiData.title, apiData.tags, apiData.thumbnail, apiData.publishedAt);
        // 2. 初回の初期統計データの登録（グローバル共有）
        await dbService.recordStats(videoId, apiData.view, apiData.comment, apiData.mylist, apiData.like);
        // 3. この鯖の通知基準値も現在値で初期化（過去のキリ番を遡って通知しないため）
        await dbService.upsertNotifyState(guildId, videoId, {
          views: apiData.view, comments: apiData.comment, mylists: apiData.mylist, likes: apiData.like,
        });

        const embed = new EmbedBuilder()
          .setTitle("🎉 New Upload Detected!")
          .setDescription(`**${apiData.title}**\n${link}`)
          .setColor(0x2ecc71)
          .setThumbnail(apiData.thumbnail)
          .setFooter({ text: config.FOOTER_TEXT })
          .setTimestamp();

        await discordService.sendNotification(guildId, embed, 'video');
      }
    }
  }

  // 2. マイルストーンチェック（その鯖が監視中の動画について、前回の判定時点と比べてキリ番を跨いでいたら通知）
  const videos = await dbService.getAllVideos(guildId);
  const milestoneStep = dbService.getSetting(guildId, 'milestone_step');

  for (const video of videos) {
    try {
      // 監視対象ユーザー自身の動画なら一括取得済みのデータを使い、
      // /add で追加された他ユーザーの動画（一括データに無い）だけ個別APIにフォールバックする
      const bulkData = bulkById.get(video.id);
      const apiData = bulkData
        ? { view: bulkData.view, comment: bulkData.comment, mylist: bulkData.mylist, like: bulkData.like, thumbnail: bulkData.thumbnail }
        : await niconico.fetchNicoData(video.id);
      if (!apiData) continue;

      // 判定基準は「この鯖が前回チェックした時点の値」。video_stats は他の鯖の
      // ジョブによって既に更新されている可能性があるため、基準には使えない。
      const previousState = await dbService.getNotifyState(guildId, video.id);

      if (previousState) {
        const statsToCheck = [
          { name: '再生', oldVal: previousState.views, newVal: apiData.view, color: 0x3498db },
          { name: 'いいね', oldVal: previousState.likes, newVal: apiData.like, color: 0xe74c3c },
          { name: 'マイリスト', oldVal: previousState.mylists, newVal: apiData.mylist, color: 0xf1c40f },
          { name: 'コメント', oldVal: previousState.comments, newVal: apiData.comment, color: 0x9b59b6 }
        ];

        for (const stat of statsToCheck) {
          const crossed = utils.checkMilestone(stat.oldVal, stat.newVal, milestoneStep);
          if (crossed) {
            await discordService.sendNotification(
              guildId,
              new EmbedBuilder()
                .setTitle(`🎊 Milestone Reached!`)
                .setDescription(`**${video.title}** が **${crossed.toLocaleString()}** ${stat.name}を突破しました！`)
                .setColor(stat.color)
                .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
                .setThumbnail(apiData.thumbnail),
              'video'
            );
          }
        }

        // 急上昇検知（再生数の伸びだけを見る）
        await checkSpike(guildId, video, previousState, apiData.view);
      }

      // タグやサムネが更新されていればDBも更新（動画マスタは鯖共通）。
      // 一括APIにはタグが含まれないため、そのときは既存のタグ値をそのまま使い、
      // 「タグが変わった」と誤検知して意味のない上書きをしないようにする。
      const newTags = apiData.tags !== undefined ? apiData.tags : video.tags;
      if (video.tags !== newTags || video.thumbnail_url !== apiData.thumbnail) {
        await dbService.updateVideoInfo(video.id, newTags, apiData.thumbnail);
      }

      // 現在の数値を記録する。統計はグローバル、通知の基準値は鯖ごと。
      await dbService.recordStats(video.id, apiData.view, apiData.comment, apiData.mylist, apiData.like);
      await dbService.upsertNotifyState(guildId, video.id, {
        views: apiData.view, comments: apiData.comment, mylists: apiData.mylist, likes: apiData.like,
      });
    } catch (videoUpdateErr) {
      console.error(`❌ Error updating video ${video.id} in background schedule:`, videoUpdateErr);
    }
  }

  // ステータスの更新（Bot全体で監視している動画の総数）
  if (discordService.client.user) {
    const watched = await dbService.getAllWatchedVideoIds();
    discordService.client.user.setActivity(`${watched.length}本の動画を監視中`, { type: 3 });
  }

  markRun('updateVideoList');
}

module.exports = { updateVideoList };
