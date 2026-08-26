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

const THUMB_INFO_TAG_RE = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

function unescapeXml(str) {
  if (!str) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractXmlTag(xml, tag) {
  const match = xml.match(THUMB_INFO_TAG_RE(tag));
  return match ? unescapeXml(match[1].trim()) : null;
}

/**
 * getthumbinfo（ニコニコの旧来の公開メタデータAPI）で動画の再生数・コメント数・
 * マイリスト数等を取得する。
 *
 * 【重要】fetchNicoData()が使う /api/watch/v3_guest/ は実際の視聴ページが
 * 読み込むデータAPIそのもの（actionTrackId付き）で、これを叩くこと自体が
 * ニコニコ側に「視聴」として計上されることをDB記録から確認した
 * （毎時の自動チェックや /daily_report 等の手動実行のたびに、その動画の
 * 公開再生数が実際に1ずつ増えていた）。getthumbinfoは埋め込みプレイヤーや
 * サムネイル表示など「視聴を伴わない」用途のために長年公開されている
 * 読み取り専用APIで、視聴セッションを生成しないため再生数を増やさない。
 * ただし「いいね」数だけはこの古いAPIのスキーマに存在しないため取得できない
 * （呼び出し側で直近の記録値を引き継ぐ想定）。
 */
async function fetchVideoThumbInfo(id) {
  try {
    const response = await axios.get(`https://ext.nicovideo.jp/api/getthumbinfo/${id}`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 5000,
      validateStatus: () => true,
    });

    const xml = typeof response.data === 'string' ? response.data : String(response.data);
    if (response.status !== 200 || !/status="ok"/.test(xml)) return null;

    const tagsBlockMatch = xml.match(/<tags[^>]*>([\s\S]*?)<\/tags>/);
    const tags = tagsBlockMatch
      ? [...tagsBlockMatch[1].matchAll(/<tag[^>]*>([\s\S]*?)<\/tag>/g)].map((m) => unescapeXml(m[1].trim())).join(', ')
      : '';

    const view = parseInt(extractXmlTag(xml, 'view_counter'), 10);
    if (Number.isNaN(view)) return null;

    return {
      view,
      comment: parseInt(extractXmlTag(xml, 'comment_num'), 10) || 0,
      mylist: parseInt(extractXmlTag(xml, 'mylist_counter'), 10) || 0,
      // getthumbinfoには「いいね」が存在しないため、呼び出し側で直近値を引き継ぐ
      like: null,
      // ユーザー投稿動画のみ存在（チャンネル投稿動画は ch_id になり null のまま）。
      // resolveLike() でいいね数を補うのに使う。
      userId: extractXmlTag(xml, 'user_id'),
      title: extractXmlTag(xml, 'title') || 'Unknown',
      thumbnail: extractXmlTag(xml, 'thumbnail_url') || '',
      tags: tags || 'No Tags',
      publishedAt: extractXmlTag(xml, 'first_retrieve'),
    };
  } catch (e) {
    console.error(`getthumbinfo API エラー (${id}):`, e.message);
    return null;
  }
}

/**
 * getthumbinfoにいいねが無い動画（監視ユーザー本人以外の投稿）のいいね数を補う。
 *
 * 投稿者のユーザーIDが分かれば、その投稿者を監視登録していなくても
 * fetchUserVideos（安全な一覧API）を単発で叩き、その中から該当動画の
 * いいねだけを拾うことができる。これなら視聴計上される危険なAPIを使わずに済む。
 *
 * 投稿者がチャンネル所属（userIdが無い）、または一覧に該当動画が見つからない
 * 場合は補えないため、呼び出し側から渡された直近の記録値をそのまま返し、
 * stale: true で「更新できなかった」ことを伝える。
 */
async function resolveLike(videoId, userId, previousLikes) {
  if (userId) {
    const list = await fetchUserVideos(userId);
    const match = list.find((v) => v.id === videoId);
    if (match) return { like: match.like, stale: false };
  }
  return { like: previousLikes || 0, stale: true };
}

/**
 * ニコニコの内部API (v3_guest) を用いて動画のリアルタイムな詳細データを取得する。
 *
 * 【注意】このAPIを叩くこと自体がニコニコ側に「視聴」として計上され、対象動画の
 * 公開再生数を実際に増やしてしまうことをDB記録から確認済み（詳細はfetchVideoThumbInfo
 * のコメント参照）。毎時の自動チェックやレポート等の定常的なポーリングには
 * fetchVideoThumbInfo（getthumbinfo）を使うこと。このAPIはやむを得ず使う
 * 場合（現状は無い）のためだけに残している。
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
    const tags = json.data.tag.items.map(t => t.name).join(", ");

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
  fetchNicoData,
  fetchVideoThumbInfo,
  resolveLike,
};
