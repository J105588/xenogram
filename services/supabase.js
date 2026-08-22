// このファイルは repositories/ 配下（videos / stats / vocacolle）への窓口。
// 動画・統計・ボカコレの3ドメインは services/repositories/ にドメインごと分割されているが、
// 呼び出し側の require('./supabase') をすべて書き換えるのは影響範囲が広いため、
// 後方互換のバレル（re-export用のファイル）として残している。
const { supabase } = require('./repositories/client');
const videos = require('./repositories/videos');
const stats = require('./repositories/stats');
const vocacolle = require('./repositories/vocacolle');

module.exports = {
  supabase,
  ...videos,
  ...stats,
  ...vocacolle,
};
