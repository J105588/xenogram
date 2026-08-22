const { supabase } = require('./client');

/* =====================================================================
 * ボカコレ ランキング監視: キーワード管理と検知履歴
 * ===================================================================== */

/**
 * 有効なキーワードを全件取得する（期間判定は呼び出し側で行う）
 */
async function getVocacolleKeywords(includeDisabled = false) {
  let query = supabase
    .from('vocacolle_keywords')
    .select('*')
    .order('id', { ascending: true });

  if (!includeDisabled) query = query.eq('enabled', true);

  const { data, error } = await query;
  if (error) {
    console.error("Error getting vocacolle keywords:", error);
    return [];
  }
  return data || [];
}

/**
 * 監視キーワードを追加する
 */
async function addVocacolleKeyword({ keyword, target = 'title', pageId = 'rookie', activeFrom = null, activeUntil = null, note = null }) {
  const { data, error } = await supabase
    .from('vocacolle_keywords')
    .insert([{
      keyword,
      target,
      page_id: pageId,
      active_from: activeFrom,
      active_until: activeUntil,
      note
    }])
    .select()
    .single();

  if (error) {
    console.error("Error adding vocacolle keyword:", error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * 監視キーワードを削除する
 */
async function removeVocacolleKeyword(id) {
  const { error } = await supabase
    .from('vocacolle_keywords')
    .delete()
    .eq('id', id);

  if (error) {
    console.error("Error removing vocacolle keyword:", error);
    return false;
  }
  return true;
}

/**
 * 既に通知済みの組み合わせかどうかを判定する
 */
async function hasVocacolleDetection(keywordId, pageId, watchId) {
  const { data, error } = await supabase
    .from('vocacolle_detections')
    .select('id')
    .eq('keyword_id', keywordId)
    .eq('page_id', pageId)
    .eq('watch_id', watchId)
    .maybeSingle();

  if (error) console.error("Error checking vocacolle detection:", error);
  return !!data;
}

/**
 * 検知履歴を保存する（新規ヒット時に1回だけ呼ばれる）
 */
async function recordVocacolleDetection(detection) {
  const { error } = await supabase
    .from('vocacolle_detections')
    .insert([{
      keyword_id: detection.keywordId,
      page_id: detection.pageId,
      watch_id: detection.watchId,
      matched_keyword: detection.matchedKeyword,
      matched_target: detection.matchedTarget,
      rank_position: detection.rank,
      title: detection.title,
      artist: detection.artist,
      view_count: detection.view,
      screenshot_ok: !!detection.screenshotOk
    }]);

  if (error) console.error("Error recording vocacolle detection:", error);
}

/**
 * 直近で記録されている順位を取得する（順位変動通知の「前回値」として使う）
 */
async function getVocacolleDetectionRank(keywordId, pageId, watchId) {
  const { data, error } = await supabase
    .from('vocacolle_detections')
    .select('rank_position')
    .eq('keyword_id', keywordId)
    .eq('page_id', pageId)
    .eq('watch_id', watchId)
    .maybeSingle();

  if (error) console.error("Error getting vocacolle detection rank:", error);
  return data ? data.rank_position : null;
}

/**
 * 既存の検知履歴行の順位・再生数を最新値に更新する（順位変動の追跡用）。
 * 行が存在しない場合（＝まだ新規ヒットとして記録されていない）は何もしない。
 */
async function touchVocacolleDetection(keywordId, pageId, watchId, { rank, view }) {
  const { error } = await supabase
    .from('vocacolle_detections')
    .update({ rank_position: rank, view_count: view })
    .eq('keyword_id', keywordId)
    .eq('page_id', pageId)
    .eq('watch_id', watchId);

  if (error) console.error("Error updating vocacolle detection rank:", error);
}

/**
 * ボカコレ監視の有効/無効フラグを取得する（未取得時はデフォルトで有効扱い）
 */
async function getVocacolleWatchEnabled() {
  const { data, error } = await supabase
    .from('vocacolle_settings')
    .select('enabled')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error("Error getting vocacolle settings:", error);
    return true;
  }
  return data ? data.enabled : true;
}

/**
 * ボカコレ監視の有効/無効を切り替える（/vc_toggle 用）
 */
async function setVocacolleWatchEnabled(enabled) {
  const { error } = await supabase
    .from('vocacolle_settings')
    .upsert({ id: 1, enabled, updated_at: new Date().toISOString() });

  if (error) {
    console.error("Error setting vocacolle watch enabled:", error);
    return false;
  }
  return true;
}

/**
 * キャッシュ済みの nvapi ランキングIDを取得する
 */
async function getVocacolleRankingSource(pageId) {
  const { data, error } = await supabase
    .from('vocacolle_ranking_sources')
    .select('ranking_id, frontend_id, resolved_at')
    .eq('page_id', pageId)
    .maybeSingle();

  if (error) {
    console.error("Error getting vocacolle ranking source:", error);
    return null;
  }
  if (!data) return null;
  return { rankingId: data.ranking_id, frontendId: data.frontend_id, resolvedAt: data.resolved_at };
}

/**
 * 解決した nvapi ランキングIDを保存する
 */
async function upsertVocacolleRankingSource(pageId, source) {
  const { error } = await supabase
    .from('vocacolle_ranking_sources')
    .upsert({
      page_id: pageId,
      ranking_id: source.rankingId,
      frontend_id: source.frontendId,
      resolved_at: source.resolvedAt
    });

  if (error) console.error("Error saving vocacolle ranking source:", error);
}

module.exports = {
  getVocacolleKeywords,
  addVocacolleKeyword,
  removeVocacolleKeyword,
  hasVocacolleDetection,
  recordVocacolleDetection,
  getVocacolleDetectionRank,
  touchVocacolleDetection,
  getVocacolleWatchEnabled,
  setVocacolleWatchEnabled,
  getVocacolleRankingSource,
  upsertVocacolleRankingSource,
};
