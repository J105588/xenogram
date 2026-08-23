const axios = require('axios');
const config = require('../config');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 指定した1ユーザーの投稿動画一覧を、再生数・いいね等の数値も含めて取得する。
 *
 * 以前は `?rss=2.0` のRSSフィードを使っていたが、ニコニコ側でこのクエリが
 * 廃止され、通常のHTMLページ（Next.jsのユーザーページ）が返るようになった。
 * XMLとしてパースできず常に0件を返し、新着動画の自動検知が完全に止まっていた。
 *
 * ユーザーページが内部で呼んでいる nvapi.nicovideo.jp の投稿動画一覧APIを
 * 直接叩くことで、RSSを介さずに新着を検知する。このAPIは投稿者の全動画の
 * 再生数・いいね・マイリスト・コメントも一度に返すため、毎時のマイルストーン
 * チェックで動画ごとに個別APIを叩く必要をなくすのにも使う（タグ情報だけは
 * このAPIに含まれないため、タグ変更検知は使えない）。
 */
async function fetchUserVideos(userId) {
  try {
    const response = await axios.get(`https://nvapi.nicovideo.jp/v3/users/${userId}/videos`, {
      params: {
        page: 1,
        pageSize: 100,
        sortKey: 'registeredAt',
        sortOrder: 'desc',
      },
      headers: {
        'User-Agent': USER_AGENT,
        'X-Frontend-Id': '6',
        'X-Frontend-Version': '0',
      },
      timeout: 5000, // 5秒タイムアウト
      validateStatus: () => true,
    });

    const meta = response.data && response.data.meta;
    if (!meta || meta.status !== 200) {
      console.error(`投稿動画一覧の取得に失敗しました (userId=${userId}):`, meta && meta.status);
      return [];
    }

    const items = (response.data.data && response.data.data.items) || [];
    return items
      .map((item) => item.essential)
      .filter(Boolean)
      .map((video) => ({
        id: video.id,
        title: video.title,
        view: (video.count && video.count.view) || 0,
        comment: (video.count && video.count.comment) || 0,
        mylist: (video.count && video.count.mylist) || 0,
        like: (video.count && video.count.like) || 0,
        thumbnail: (video.thumbnail && video.thumbnail.url) || '',
        registeredAt: video.registeredAt || null,
      }));
  } catch (e) {
    console.error(`投稿動画一覧の取得エラー (userId=${userId}):`, e.message);
    return [];
  }
}

/**
 * その鯖が監視対象にしているユーザーぶんをまとめて取得する。
 * ユーザーIDは /user_add で登録されたもの（DB・鯖ごと）だけを使う。
 * 未登録の鯖は空配列が返り、APIも一切叩かない
 * （Botを入れただけのサーバーが勝手に誰かを監視し始めないようにするため）。
 */
async function fetchAllUserVideos(guildId) {
  const dbService = require('./database');
  const userIds = dbService.getNicoUserIds(guildId);
  const results = await Promise.all(userIds.map((userId) => fetchUserVideos(userId)));
  return results.flat();
}

/**
 * 新着検知用に { link, title } の形だけを返す（fetchAllUserVideos の薄いラッパー）
 */
async function getRssItems(guildId) {
  const videos = await fetchAllUserVideos(guildId);
  return videos.map((video) => ({
    link: `https://www.nicovideo.jp/watch/${video.id}`,
    title: video.title,
  }));
}

/**
 * ニコニコの内部API (v3_guest) を用いて動画のリアルタイムな詳細データを取得する
 */
async function fetchNicoData(id) {
  // アクション追跡IDの生成 (10桁英数字 + タイムスタンプ)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let randomStr = '';
  for (let i = 0; i < 10; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const actionTrackId = `${randomStr}_${Date.now()}`;

  const url = `https://www.nicovideo.jp/api/watch/v3_guest/${id}?actionTrackId=${actionTrackId}`;

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "X-Frontend-Id": "70",
        "X-Frontend-Version": "0",
        "X-Niconico-Language": "ja-jp"
      },
      timeout: 5000, // 5秒でタイムアウトさせる（フリーズ防止）
      validateStatus: () => true // エラーコードでも例外を投げない
    });

    if (response.status !== 200) return null; // 非公開や削除の場合はnull

    const json = response.data;
    if (json.meta.status !== 200 || !json.data) return null;

    const video = json.data.video;
    const tags = json.data.tag.items.map(t => t.name).slice(0, 3).join(", ");

    return {
      view: video.count.view || 0,
      comment: video.count.comment || 0,
      mylist: video.count.mylist || 0,
      like: video.count.like || 0,
      title: video.title || "Unknown",
      thumbnail: video.thumbnail.url || "",
      tags: tags || "No Tags",
      publishedAt: video.registeredAt || null // 投稿日時を取得
    };
  } catch (e) {
    console.error(`v3_guest API エラー (${id}):`, e.message);
    return null;
  }
}

module.exports = {
  getRssItems,
  fetchAllUserVideos,
  fetchNicoData
};
