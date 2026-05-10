const Parser = require('rss-parser');
const parser = new Parser();
const config = require('./config');

async function run() {
  console.log("Fetching RSS for user ID:", config.NICO_USER_ID);
  const rssUrl = `https://www.nicovideo.jp/user/${config.NICO_USER_ID}/video?rss=2.0`;
  try {
    const feed = await parser.parseURL(rssUrl);
    console.log("Feed Title:", feed.title);
    if (feed.items.length > 0) {
      const item = feed.items[0];
      console.log("Example Item Link Raw:", item.link);
      const videoId = item.link.split("/").pop().split("?")[0].trim();
      console.log("Extracted Video ID:", videoId);
    } else {
      console.log("No items found in RSS feed.");
    }
  } catch (e) {
    console.error("Error fetching rss:", e);
  }
}

run();
