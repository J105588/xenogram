// repositories/ 配下（videos / stats / vocacolle / settings / nicoUsers）への窓口。
// データはこのマシン上のSQLiteファイル（data/xenogram.sqlite）に保存される
// （以前はSupabase＝外部PostgreSQLだったが、ローカル常駐運用にしたため依存をやめた）。
const videos = require('./repositories/videos');
const stats = require('./repositories/stats');
const vocacolle = require('./repositories/vocacolle');
const settings = require('./repositories/settings');
const nicoUsers = require('./repositories/nicoUsers');

module.exports = {
  ...videos,
  ...stats,
  ...vocacolle,
  ...settings,
  ...nicoUsers,
};
