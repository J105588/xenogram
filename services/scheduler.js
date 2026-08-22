const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const niconico = require('./niconico');
const vocacolle = require('./vocacolle');
const screenshot = require('./screenshot');
const supabaseService = require('./supabase');
const discordService = require('./discord');
const utils = require('../utils');
const config = require('../config');

// キリ番（マイルストーン）の設定単位
const MILESTONE_STEP = 100;

// 各定期ジョブが最後に成功した時刻（/status コマンド用）。
// プロセス内メモリのみで保持するため、再起動すると null に戻る
// （＝「再起動後まだ1回も実行されていない」ことがそのまま可視化される）
const lastRunAt = {
  updateVideoList: null,
  reportEachVideoStats: null,
  vocacolleWatch: null,
};

function getSchedulerStatus() {
  return { ...lastRunAt };
}

/**
 * 【1時間ごとに実行】新着動画の検知とマイルストーンチェック
 */
async function updateVideoList() {
  console.log("Running hourly updateVideoList...");

  // 1. RSSから新着動画をチェック
  const items = await niconico.getRssItems();
  // 投稿日時が古い順（過去から現在へ）に並べ替えて処理することで、重複防止と投稿順の整合性を保つ
  const reversedItems = [...items].reverse(); 
  
  for (const item of reversedItems) {
    // URLからIDを抽出
    const link = item.link;
    const videoId = link.split("/").pop().split("?")[0].trim();
    
    const exists = await supabaseService.hasVideo(videoId);
    if (!exists) {
      console.log(`New video detected: ${videoId}`);
      // 詳細データを取得
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
      const apiData = await niconico.fetchNicoData(video.id);
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
          const crossed = utils.checkMilestone(stat.oldVal, stat.newVal, MILESTONE_STEP);
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
      }
      
      // タグやサムネが更新されていればDBも更新
      if (video.tags !== apiData.tags || video.thumbnail_url !== apiData.thumbnail) {
        await supabaseService.updateVideoInfo(video.id, apiData.tags, apiData.thumbnail);
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

  lastRunAt.updateVideoList = new Date().toISOString();
}

/**
 * 【毎朝7時に実行】各動画の前日比とグラフを含むレポート送信
 */
async function reportEachVideoStats() {
  console.log("Running daily reportEachVideoStats...");
  
  if (!config.DISCORD.CHANNEL_ID) {
    throw new Error("⚠️ DISCORD_CHANNEL_ID is not set in configuration!");
  }

  const videos = await supabaseService.getAllVideos();

  for (const video of videos) {
    try {
      const apiData = await niconico.fetchNicoData(video.id);
      if (!apiData) {
        console.warn(`⚠️ Skipping report for ${video.id}: Failed to fetch Niconico data.`);
        continue;
      }

      const latestDbStats = await supabaseService.getYesterdayStats(video.id);
      const diff = utils.calculateDiff(apiData, latestDbStats);
      
      // 新しい統計をDBに記録
      await supabaseService.recordStats(video.id, apiData.view, apiData.comment, apiData.mylist, apiData.like);

      // グラフURLの生成
      const history = await supabaseService.getStatsHistory(video.id);
      const chartUrl = utils.generateChartUrl(history);

      const embed = new EmbedBuilder()
        .setTitle(`Analytics: ${apiData.title}`)
        .setURL(`https://www.nicovideo.jp/watch/${video.id}`)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setThumbnail(apiData.thumbnail)
        .addFields(
          { name: "Views", value: `**${apiData.view.toLocaleString()}** (${utils.formatDiff(diff.view)})`, inline: true },
          { name: "Likes", value: `**${apiData.like.toLocaleString()}** (${utils.formatDiff(diff.like)})`, inline: true },
          { name: "Mylist", value: `**${apiData.mylist.toLocaleString()}** (${utils.formatDiff(diff.mylist)})`, inline: true },
          { name: "Comments", value: `**${apiData.comment.toLocaleString()}** (${utils.formatDiff(diff.comment)})`, inline: true },
          { name: "Tags", value: `\`${apiData.tags}\``, inline: false }
        )
        .setFooter({ text: config.FOOTER_TEXT })
        .setTimestamp();

      if (chartUrl) {
        embed.setImage(chartUrl);
      }

      await discordService.sendNotification(embed);
    } catch (itemError) {
      console.error(`❌ Failed to generate/send report for video ${video.id}:`, itemError);
      // 1本の動画で失敗しても、他の動画のレポート処理を止めずに次へ進む
    }
  }

  lastRunAt.reportEachVideoStats = new Date().toISOString();
}

/**
 * 【毎時5分に実行】ボカコレのランキングを取得し、
 * 登録キーワード（曲名／アーティスト名の完全一致）にヒットしたらスクショ付きで通知する
 *
 * @param {object} [options]
 * @param {boolean} [options.force] true なら通知済みでも再通知する（手動確認用）
 * @param {boolean} [options.bypassToggle] true なら /vc_toggle off で無効化中でも実行する（/vc_check 用）
 * @param {boolean} [options.notifySummary] true なら新規ヒットが無くてもチェック結果をチャンネルに通知する（定期実行用）
 * @param {boolean} [options.summaryScreenshot] false を渡すとサマリーのスクショを省略する（既定は true）
 * @returns {Promise<{checked: number, hits: number, notified: number, rankingTitle: string, skipped?: string}>}
 */
let vocacolleWatchInFlight = false;

async function runVocacolleWatch(options = {}) {
  const { force = false, bypassToggle = false, notifySummary = false, summaryScreenshot = true } = options;

  // 同時に複数のChromiumが立ち上がると無駄にメモリを食い、
  // ランキングページへの同時アクセスも増えるため、常に1本だけ走らせる。
  // （毎時の自動実行中に手動 /vc_check を叩いた場合などを弾く）
  if (vocacolleWatchInFlight) {
    console.warn("[VOCACOLLE] 前回の実行がまだ完了していないため、今回はスキップします");
    return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'already_running' };
  }
  vocacolleWatchInFlight = true;

  try {
    return await runVocacolleWatchInner({ force, bypassToggle, notifySummary, summaryScreenshot });
  } finally {
    vocacolleWatchInFlight = false;
  }
}

async function runVocacolleWatchInner({ force, bypassToggle, notifySummary, summaryScreenshot }) {
  console.log("Running vocacolle ranking watch...");

  if (!bypassToggle) {
    const enabled = await supabaseService.getVocacolleWatchEnabled();
    if (!enabled) {
      console.log("[VOCACOLLE] /vc_toggle off により無効化されているため処理をスキップします");
      return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'disabled' };
    }
  }

  const keywords = await supabaseService.getVocacolleKeywords();
  if (!keywords.length) {
    console.log("[VOCACOLLE] 有効な監視キーワードが未登録のため処理をスキップします");
    return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'no_keywords' };
  }

  const ranking = await vocacolle.fetchRanking(config.VOCACOLLE.RANKING_URL, {
    getCachedSource: (pageId) => supabaseService.getVocacolleRankingSource(pageId),
    setCachedSource: (pageId, source) => supabaseService.upsertVocacolleRankingSource(pageId, source)
  });
  const now = new Date();
  const activeCount = keywords.filter(k => vocacolle.isActive(k, now)).length;
  console.log(`[VOCACOLLE] ${ranking.title} ${ranking.items.length}件を取得 / 有効キーワード ${activeCount}件`);

  const matches = vocacolle.findMatches(ranking, keywords, now);

  // 既に通知済みの組み合わせを除外する
  const pending = [];
  for (const match of matches) {
    if (!force) {
      const already = await supabaseService.hasVocacolleDetection(match.keyword.id, ranking.pageId, match.item.watchId);
      if (already) continue;
    }
    pending.push(match);
  }

  if (!pending.length) {
    console.log(`[VOCACOLLE] 新規のヒットはありません（ヒット総数 ${matches.length}件）`);

    if (notifySummary) {
      const embed = new EmbedBuilder()
        .setTitle('ボカコレ監視 定期チェック')
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setDescription(ranking.title)
        .addFields(
          { name: '順位表', value: `${ranking.items.length}件`, inline: true },
          { name: '有効キーワード', value: `${activeCount}件`, inline: true },
          { name: 'ヒット', value: `${matches.length}件（新規: 0件）`, inline: true }
        );

      if (matches.length) {
        // 新規ではなくても、現在該当している曲の最新の順位・数値を毎回出す
        const lines = matches.map(({ keyword, item }) => {
          const targetLabel = keyword.target === 'artist' ? 'アーティスト名' : '曲名';
          return `**${item.rank}位** [${item.title}](https://www.nicovideo.jp/watch/${item.watchId}) / ${item.artist}\n　再生 ${item.view.toLocaleString()}・いいね ${item.like.toLocaleString()}（一致: ${targetLabel} \`${keyword.keyword}\`）`;
        });
        let listText = lines.join('\n');
        if (listText.length > 1000) listText = listText.slice(0, 950) + '\n... (省略されました)';
        embed.addFields({ name: '現在の該当曲（最新の数値）', value: listText, inline: false });
      } else {
        embed.addFields({ name: '現在の該当曲', value: '現在ヒットしているものはありません。', inline: false });
      }

      embed.setFooter({ text: config.FOOTER_TEXT }).setTimestamp();

      // 定期サマリー・手動確認のどちらでも、該当曲があればスクショを添える。
      // Discordの1メッセージあたりEmbed上限が10件なので、サマリー分を除いた9件が上限。
      const embedsToSend = [embed];
      const files = [];

      if (summaryScreenshot && matches.length) {
        const uniqueItems = [];
        const seenWatchIds = new Set();
        for (const { item } of matches) {
          if (!item.watchId || seenWatchIds.has(item.watchId)) continue;
          seenWatchIds.add(item.watchId);
          uniqueItems.push(item);
          if (uniqueItems.length >= 9) break;
        }

        const shots = await screenshot.captureRankingEntries({
          url: config.VOCACOLLE.RANKING_URL,
          watchIds: uniqueItems.map(i => i.watchId)
        });

        for (const item of uniqueItems) {
          const shot = shots.get(item.watchId);
          const itemEmbed = new EmbedBuilder()
            .setTitle(`${item.rank}位: ${item.title}`)
            .setURL(`https://www.nicovideo.jp/watch/${item.watchId}`)
            .setColor(parseInt(config.CHART_COLOR, 16));

          if (shot) {
            const fileName = `vocacolle_summary_${item.watchId}.png`;
            files.push({ buffer: shot.buffer, name: fileName });
            itemEmbed.setImage(`attachment://${fileName}`);
          }
          embedsToSend.push(itemEmbed);
        }
      }

      await discordService.sendEmbedWithFiles({ channelId: config.VOCACOLLE.CHANNEL_ID, embeds: embedsToSend, files });
    }

    lastRunAt.vocacolleWatch = new Date().toISOString();
    return { checked: ranking.items.length, hits: matches.length, notified: 0, rankingTitle: ranking.title };
  }

  // 重複する動画は1回だけ撮影する
  const uniqueWatchIds = [...new Set(pending.map(m => m.item.watchId).filter(Boolean))];
  const shots = await screenshot.captureRankingEntries({
    url: config.VOCACOLLE.RANKING_URL,
    watchIds: uniqueWatchIds
  });

  let notified = 0;

  for (const { keyword, item } of pending) {
    try {
      const shot = shots.get(item.watchId);
      const targetLabel = keyword.target === 'artist' ? 'アーティスト名' : '曲名';

      const embed = new EmbedBuilder()
        .setTitle(`ボカコレ ${ranking.title}ランキング ${item.rank}位 で検知`)
        .setURL(item.watchId ? `https://www.nicovideo.jp/watch/${item.watchId}` : ranking.url)
        .setColor(parseInt(config.CHART_COLOR, 16))
        .setDescription(`**${item.title}**\n${item.artist}`)
        .addFields(
          { name: "順位", value: `**${item.rank}** / ${ranking.items.length}`, inline: true },
          { name: "再生", value: item.view.toLocaleString(), inline: true },
          { name: "いいね", value: item.like.toLocaleString(), inline: true },
          { name: "マイリスト", value: item.mylist.toLocaleString(), inline: true },
          { name: "コメント", value: item.comment.toLocaleString(), inline: true },
          { name: "一致条件", value: `${targetLabel}: \`${keyword.keyword}\``, inline: true }
        )
        .setFooter({ text: config.FOOTER_TEXT })
        .setTimestamp();

      if (item.thumbnail) embed.setThumbnail(item.thumbnail);

      const files = [];
      if (shot) {
        const fileName = `vocacolle_${item.watchId || 'ranking'}.png`;
        files.push({ buffer: shot.buffer, name: fileName });
        embed.setImage(`attachment://${fileName}`);
      } else {
        embed.addFields({ name: "注意", value: "スクリーンショットの取得に失敗しました。", inline: false });
      }

      const sent = await discordService.sendEmbedWithFiles({
        channelId: config.VOCACOLLE.CHANNEL_ID,
        embed,
        files
      });

      if (sent) notified += 1;

      if (!force) {
        await supabaseService.recordVocacolleDetection({
          keywordId: keyword.id,
          pageId: ranking.pageId,
          watchId: item.watchId,
          matchedKeyword: keyword.keyword,
          matchedTarget: keyword.target,
          rank: item.rank,
          title: item.title,
          artist: item.artist,
          view: item.view,
          screenshotOk: !!shot
        });
      }
    } catch (itemError) {
      // 1件失敗しても残りの通知は続行する
      console.error(`[VOCACOLLE] ${item.watchId} の通知処理に失敗しました:`, itemError);
    }
  }

  console.log(`[VOCACOLLE] ${notified}件を通知しました`);
  lastRunAt.vocacolleWatch = new Date().toISOString();
  return { checked: ranking.items.length, hits: matches.length, notified, rankingTitle: ranking.title };
}

function startScheduler() {
  // 1時間に1回 (毎時0分)
  cron.schedule('0 * * * *', () => {
    updateVideoList().catch(async err => {
      console.error(err);
      await discordService.sendErrorEmbed(err, "🚨 Scheduler: Hourly Update Failed");
    });
  }, { timezone: "Asia/Tokyo" });

  // 毎朝7時0分（日本時間）
  cron.schedule('0 7 * * *', () => {
    reportEachVideoStats().catch(async err => {
      console.error(err);
      await discordService.sendErrorEmbed(err, "🚨 Scheduler: Daily Report Failed");
    });
  }, { timezone: "Asia/Tokyo" });
  
  // ボカコレ ランキング監視 (既定: 毎時5分)
  if (config.VOCACOLLE.ENABLED) {
    cron.schedule(config.VOCACOLLE.CRON, () => {
      runVocacolleWatch({ notifySummary: true }).catch(async err => {
        console.error(err);
        await discordService.sendErrorEmbed(err, "🚨 Scheduler: Vocacolle Watch Failed");
      });
    }, { timezone: "Asia/Tokyo" });
    console.log(`Vocacolle watcher scheduled: "${config.VOCACOLLE.CRON}" (Asia/Tokyo)`);
  } else {
    console.log("Vocacolle watcher is disabled (VOCACOLLE_ENABLED=false).");
  }

  console.log("Schedulers started.");
}

module.exports = {
  startScheduler,
  updateVideoList,
  reportEachVideoStats,
  runVocacolleWatch,
  getSchedulerStatus
};
