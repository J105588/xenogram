// discord/ 配下（client / definitions / router / commands）への窓口。
// 呼び出し側の require('./discord') をすべて書き換えるのは影響範囲が広いため、
// 後方互換のバレルとして残している。
module.exports = require('./discord/index');
