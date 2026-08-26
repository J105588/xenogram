const { EmbedBuilder } = require('discord.js');
const vocacolle = require('../vocacolle');
const screenshot = require('../screenshot');
const dbService = require('../database');
const discordService = require('../discord');
const config = require('../../config');
const { markRun } = require('./status');
const { withSingleFlight } = require('../singleFlight');

/**
 * 現在ヒットしている（新規ではない）曲について、前回記録した順位と比べて
 * 大きく動いていれば個別に通知し、記録済みの順位を最新値に更新する。
 * 新規ヒット（まだ vocacolle_detections に行が無い）はここでは何もしない
 * （前回値が無いので比較しようがない。次回のチェックから対象になる）。
 */
async function checkRankChanges(guildId, matches, ranking) {
  for (const { keyword, item } of matches) {
    if (!item.watchId) continue;

    const prevRank = await dbService.getVocacolleDetectionRank(keyword.id, ranking.pageId, item.watchId);
    if (prevRank === null) continue; // 新規ヒットでまだ記録が無い

    const delta = prevRank - item.rank; // 正: 順位上昇（数字が小さくなった）, 負: 順位下降
    if (Math.abs(delta) >= dbService.getSetting(guildId, 'vocacolle_rank_change_threshold')) {
      const direction = delta > 0 ? '上昇' : '下降';
      const arrow = delta > 0 ? '🔺' : '🔻';
      const embed = new EmbedBuilder()
        .setTitle(`${arrow} 順位が${direction}しました`)
        .setURL(`https://www.nicovideo.jp/watch/${item.watchId}`)
        .setColor(delta > 0 ? 0x2ecc71 : 0xe74c3c)
        .setDescription(`**${item.title}**\n${item.artist}`)
        .addFields(
          { name: '順位変化', value: `${prevRank}位 → **${item.rank}位**（${arrow}${Math.abs(delta)}）`, inline: false },
          { name: '再生', value: item.view.toLocaleString(), inline: true },
          { name: 'いいね', value: item.like.toLocaleString(), inline: true }
        )
        .setFooter({ text: config.FOOTER_TEXT })
        .setTimestamp();
      if (item.thumbnail) embed.setThumbnail(item.thumbnail);

      await discordService.sendEmbedWithFiles({ guildId, kind: 'vocacolle', embed, files: [] });
    }

    await dbService.touchVocacolleDetection(keyword.id, ranking.pageId, item.watchId, {
      rank: item.rank,
      view: item.view,
    });
  }
}

/**
 * ランキングページ1つぶんのチェック処理。
 * ボカコレ専用ではなく、「ページURL → nvapiランキングID解決 → キーワード照合」という
 * 仕組みは他のニコニコ内ランキングにも使えるため、複数URLを扱えるようループの1反復として
 * 独立させてある（呼び出し元の runVocacolleWatchInner が config.VOCACOLLE.RANKING_URLS 分だけ呼ぶ）。
 */
async function checkOnePage(guildId, url, keywords, { force, notifySummary, summaryScreenshot }) {
  const ranking = await vocacolle.fetchRanking(url, {
    getCachedSource: (pageId) => dbService.getVocacolleRankingSource(pageId),
    setCachedSource: (pageId, source) => dbService.upsertVocacolleRankingSource(pageId, source)
  });
  const now = new Date();
  const activeCount = keywords.filter(k => vocacolle.isActive(k, now)).length;
  console.log(`[VOCACOLLE] ${ranking.title} ${ranking.items.length}件を取得 / 有効キーワード ${activeCount}件`);

  const matches = vocacolle.findMatches(ranking, keywords, now);

  // 新規（まだ通知していない）ものと、既に通知済みで継続中のものに分ける。
  // 以前は新規が1件でもあると継続分の処理を丸ごとスキップしてしまい、
  // 「新規と継続が同時に出た回は継続分に何も通知が飛ばない」不具合があったため、
  // 新規・継続の両方を必ず処理する構造にしている。
  const pending = [];
  const continuing = [];
  for (const match of matches) {
    if (!force) {
      const already = await dbService.hasVocacolleDetection(match.keyword.id, ranking.pageId, match.item.watchId);
      if (already) {
        continuing.push(match);
        continue;
      }
    }
    pending.push(match);
  }

  console.log(`[VOCACOLLE] ヒット総数 ${matches.length}件（新規 ${pending.length}件 / 継続 ${continuing.length}件）`);

  // 継続中のヒットは、新規の有無に関わらず毎回順位変動をチェックする
  if (continuing.length && !force) {
    await checkRankChanges(guildId, continuing, ranking);
  }

  let notified = 0;

  // 新規ヒット: リッチな個別通知（スクショ付き）
  if (pending.length) {
    const uniqueWatchIds = [...new Set(pending.map(m => m.item.watchId).filter(Boolean))];
    const shots = await screenshot.captureRankingEntries({ url, watchIds: uniqueWatchIds });

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

        const sent = await discordService.sendEmbedWithFiles({ guildId, kind: 'vocacolle', embed, files });
        if (sent) notified += 1;

        if (!force) {
          await dbService.recordVocacolleDetection({
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

    console.log(`[VOCACOLLE] 新規 ${notified}件を通知しました`);
  }

  // 定期サマリー: 新規ヒットは既に個別通知済みなので、ここでは継続中の分だけ最新値を出す
  // （二重表示を避けるため）。新規のみで継続が0件の場合も、その旨を明記する。
  if (notifySummary) {
    const embed = new EmbedBuilder()
      .setTitle('ボカコレ監視 定期チェック')
      .setColor(parseInt(config.CHART_COLOR, 16))
      .setDescription(ranking.title)
      .addFields(
        { name: '順位表', value: `${ranking.items.length}件`, inline: true },
        { name: '有効キーワード', value: `${activeCount}件`, inline: true },
        { name: 'ヒット', value: `${matches.length}件（新規: ${pending.length}件・上で個別通知済み）`, inline: true }
      );

    if (continuing.length) {
      const lines = continuing.map(({ keyword, item }) => {
        const targetLabel = keyword.target === 'artist' ? 'アーティスト名' : '曲名';
        return `**${item.rank}位** [${item.title}](https://www.nicovideo.jp/watch/${item.watchId}) / ${item.artist}\n　再生 ${item.view.toLocaleString()}・いいね ${item.like.toLocaleString()}（一致: ${targetLabel} \`${keyword.keyword}\`）`;
      });
      let listText = lines.join('\n');
      if (listText.length > 1000) listText = listText.slice(0, 950) + '\n... (省略されました)';
      embed.addFields({ name: '継続中の該当曲（最新の数値）', value: listText, inline: false });
    } else {
      embed.addFields({ name: '継続中の該当曲', value: matches.length ? '今回は新規のみでした。' : '現在ヒットしているものはありません。', inline: false });
    }

    embed.setFooter({ text: config.FOOTER_TEXT }).setTimestamp();

    // Discordの1メッセージあたりEmbed上限が10件なので、サマリー分を除いた9件が上限。
    const embedsToSend = [embed];
    const files = [];

    if (summaryScreenshot && continuing.length) {
      const uniqueItems = [];
      const seenWatchIds = new Set();
      for (const { item } of continuing) {
        if (!item.watchId || seenWatchIds.has(item.watchId)) continue;
        seenWatchIds.add(item.watchId);
        uniqueItems.push(item);
        if (uniqueItems.length >= 9) break;
      }

      const shots = await screenshot.captureRankingEntries({
        url,
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

    await discordService.sendEmbedWithFiles({ guildId, kind: 'vocacolle', embeds: embedsToSend, files });
  }

  return { checked: ranking.items.length, hits: matches.length, notified, rankingTitle: ranking.title };
}

/**
 * 【毎時5分に実行】監視対象の各ランキングページを取得し、
 * 登録キーワード（曲名／アーティスト名の完全一致）にヒットしたらスクショ付きで通知する。
 * config.VOCACOLLE.RANKING_URLS に複数URLがあれば、それぞれ独立にチェックする。
 *
 * @param {object} [options]
 * @param {boolean} [options.force] true なら通知済みでも再通知する（手動確認用）
 * @param {boolean} [options.bypassToggle] true なら /vc_toggle off で無効化中でも実行する（/vc_check 用）
 * @param {boolean} [options.notifySummary] true なら新規ヒットが無くてもチェック結果をチャンネルに通知する（定期実行用）
 * @param {boolean} [options.summaryScreenshot] false を渡すとサマリーのスクショを省略する（既定は true）
 * @returns {Promise<{checked: number, hits: number, notified: number, rankingTitle: string, skipped?: string}>}
 */
async function runVocacolleWatch(guildId, options = {}) {
  const { force = false, bypassToggle = false, notifySummary = false, summaryScreenshot = true } = options;

  // ロックは他ジョブ（updateVideoList等）と同じく鯖ごとに分ける。
  // 以前はBot全体で1本のロックキーだったため、複数の鯖が同じスケジュール
  // （既定は全鯖とも毎時5分）でこのジョブを持つと、先に実行を掴んだ鯖以外は
  // 「実行中なのでスキップ」判定になり、その鯖のボカコレ監視だけ通知が
  // 定期的に飛ばなくなる不具合があった（Chromiumはpendingヒットがある時だけ
  // 起動するため、同時起動は稀なケースに限られる）。
  const outcome = await withSingleFlight(`vocacolleWatch:${guildId}`, () =>
    runVocacolleWatchInner(guildId, { force, bypassToggle, notifySummary, summaryScreenshot })
  );
  if (!outcome.ok) {
    console.warn(`[VOCACOLLE] 前回の実行がまだ完了していないため、今回はスキップします (guild: ${guildId})`);
    return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'already_running' };
  }
  return outcome.result;
}

async function runVocacolleWatchInner(guildId, { force, bypassToggle, notifySummary, summaryScreenshot }) {
  console.log(`Running vocacolle ranking watch... (guild: ${guildId})`);

  // 通知先が未設定なら、ランキング取得もスクショ撮影も無駄になる。
  // Chromiumを起動する前に打ち切る。
  if (!dbService.resolveChannelId(guildId, 'vocacolle')) {
    console.log(`[VOCACOLLE] 通知先チャンネルが未設定のためスキップします (guild: ${guildId})`);
    return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'no_channel' };
  }

  if (!bypassToggle) {
    const enabled = await dbService.getVocacolleWatchEnabled(guildId);
    if (!enabled) {
      console.log(`[VOCACOLLE] /vc_toggle off により無効化されているため処理をスキップします (guild: ${guildId})`);
      return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'disabled' };
    }
  }

  const keywords = await dbService.getVocacolleKeywords(guildId);
  if (!keywords.length) {
    console.log(`[VOCACOLLE] 有効な監視キーワードが未登録のため処理をスキップします (guild: ${guildId})`);
    return { checked: 0, hits: 0, notified: 0, rankingTitle: '', skipped: 'no_keywords' };
  }

  let totalChecked = 0;
  let totalHits = 0;
  let totalNotified = 0;
  const rankingTitles = [];
  // 取得失敗したページを記録する。ここを握りつぶすと「本当に0件だった」のか
  // 「取得自体に失敗して0件のまま返している」のかが呼び出し元から区別できず、
  // /vc_check が実際にはヒットがあるはずの回でも「ヒット0件」の正常応答に見えてしまう。
  const failures = [];

  for (const url of config.VOCACOLLE.RANKING_URLS) {
    try {
      const result = await checkOnePage(guildId, url, keywords, { force, notifySummary, summaryScreenshot });
      totalChecked += result.checked;
      totalHits += result.hits;
      totalNotified += result.notified;
      if (result.rankingTitle) rankingTitles.push(result.rankingTitle);
    } catch (pageError) {
      // 1ページの取得に失敗しても、他のページのチェックは続行する
      console.error(`[VOCACOLLE] ${url} のチェックに失敗しました:`, pageError);
      failures.push({ url, message: pageError.message });
    }
  }

  markRun('vocacolleWatch');
  return {
    checked: totalChecked,
    hits: totalHits,
    notified: totalNotified,
    rankingTitle: rankingTitles.join(' / '),
    failures,
  };
}

module.exports = { runVocacolleWatch };
