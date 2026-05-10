const axios = require('axios');
const Parser = require('rss-parser');
const config = require('../config');

const parser = new Parser();

/**
 * ニコニコ動画のRSSを取得し、新着動画のリストを返す
 */
async function getRssItems() {
  const rssUrl = `https://www.nicovideo.jp/user/${config.NICO_USER_ID}/video?rss=2.0`;
  try {
    // User-Agentがないと406エラーになる場合があるため、axiosでカスタムヘッダー付きで取得
    const response = await axios.get(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const feed = await parser.parseString(response.data);
    return feed.items; // [{ title, link, ... }, ...]
  } catch (e) {
    console.error("RSS取得エラー:", e.message);
    return [];
  }
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
        "X-Frontend-Id": "70",
        "X-Frontend-Version": "0",
        "X-Niconico-Language": "ja-jp"
      },
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
      tags: tags || "No Tags"
    };
  } catch (e) {
    console.error(`v3_guest API エラー (${id}):`, e.message);
    return null;
  }
}

module.exports = {
  getRssItems,
  fetchNicoData
};
