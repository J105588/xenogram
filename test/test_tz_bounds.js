process.env.TZ = 'Asia/Tokyo';

const now = new Date();
console.log("Now (JST):", now.toLocaleString());
const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();

console.log("Start of Day (UTC ISO):", startOfDay);
console.log("End of Day (UTC ISO):", endOfDay);

const startJST = new Date(startOfDay).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
const endJST = new Date(endOfDay).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

console.log("Start of Day mapped back to JST:", startJST);
console.log("End of Day mapped back to JST:", endJST);
