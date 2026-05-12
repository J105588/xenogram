const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const niconico = require('./niconico');
const supabaseService = require('./supabase');
const discordService = require('./discord');
const utils = require('../utils');
const config = require('../config');

// キリ番（マイルストーン）の設定単位
const MILESTONE_STEP = 100;

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
  
  console.log("Schedulers started.");
}

module.exports = {
  startScheduler,
  updateVideoList,
  reportEachVideoStats
};
