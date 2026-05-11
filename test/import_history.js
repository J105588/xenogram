const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const rawData = [
  {
    id: 'sm45971249',
    history: [
      { date: "2026-05-07T21:55:28", v: 870, c: 34, m: 12, l: 100 },
      { date: "2026-05-08T07:00:59", v: 872, c: 34, m: 12, l: 100 },
      { date: "2026-05-09T07:00:59", v: 874, c: 34, m: 12, l: 101 },
      { date: "2026-05-10T07:00:58", v: 875, c: 34, m: 12, l: 101 },
      { date: "2026-05-11T07:00:58", v: 876, c: 34, m: 12, l: 101 }
    ]
  },
  {
    id: 'sm46215434',
    history: [
      { date: "2026-05-07T21:55:30", v: 644, c: 27, m: 21, l: 94 },
      { date: "2026-05-08T07:01:01", v: 667, c: 29, m: 22, l: 96 },
      { date: "2026-05-09T07:01:01", v: 688, c: 29, m: 22, l: 98 },
      { date: "2026-05-10T07:01:00", v: 729, c: 32, m: 24, l: 109 },
      { date: "2026-05-11T07:01:00", v: 763, c: 35, m: 24, l: 114 }
    ]
  }
];

// ニコニコから最新情報を取得するための簡易関数
async function fetchVideoInfo(id) {
  try {
    const url = `https://www.nicovideo.jp/api/watch/v3_guest/${id}?actionTrackId=migrator_${Date.now()}`;
    const res = await axios.get(url, {
      headers: { "X-Frontend-Id": "70", "X-Frontend-Version": "0", "X-Niconico-Language": "ja-jp" }
    });
    const data = res.data.data;
    return {
      title: data.video.title,
      tags: data.tag.items.map(t => t.name).slice(0, 3).join(", "),
      thumbnail: data.video.thumbnail.url,
      publishedAt: data.video.registeredAt
    };
  } catch (e) {
    console.log(`Failed to fetch metadata for ${id}, using defaults.`);
    return { title: `Video ${id}`, tags: "import", thumbnail: "", publishedAt: null };
  }
}

async function run() {
  console.log("Starting migration...");
  for (const video of rawData) {
    console.log(`Processing ${video.id}...`);

    // 1. Check if video exists
    const { data: existing } = await supabase.from('videos').select('id').eq('id', video.id).single();

    if (!existing) {
      console.log(`Adding video ${video.id} to videos table...`);
      const meta = await fetchVideoInfo(video.id);
      const { error: addErr } = await supabase.from('videos').insert([{
        id: video.id,
        title: meta.title,
        tags: meta.tags,
        thumbnail_url: meta.thumbnail,
        published_at: meta.publishedAt
      }]);
      if (addErr) {
        console.error(`Failed to insert video entry for ${video.id}:`, addErr);
        continue;
      }
    }

    // 2. Insert historical data points (skipping already existing timestamps)
    console.log(`Processing ${video.history.length} historical data points for ${video.id}...`);
    
    for (const h of video.history) {
      // 日付文字列に日本時間（+09:00）を明示的に付与してパースする
      const jstTimestamp = h.date.includes('T') ? `${h.date}+09:00` : `${h.date.replace(' ', 'T')}+09:00`;
      const timestamp = new Date(jstTimestamp).toISOString();
      
      // すでに同じ時間のデータが入っていないか確認
      const { data: existingStat } = await supabase
        .from('video_stats')
        .select('id')
        .eq('video_id', video.id)
        .eq('recorded_at', timestamp)
        .single();
        
      if (existingStat) {
        console.log(`  -> Skip: Stats for ${timestamp} already exist.`);
        continue;
      }
      
      console.log(`  -> Inserting stats for ${timestamp}...`);
      const { error: statErr } = await supabase.from('video_stats').insert([{
        video_id: video.id,
        views: h.v,
        comments: h.c,
        mylists: h.m,
        likes: h.l,
        recorded_at: timestamp
      }]);
      
      if (statErr) {
        console.error(`  ❌ Failed to insert stats for ${timestamp}:`, statErr);
      }
    }
    console.log(`Finished processing for ${video.id}`);
  }
  console.log("Migration complete.");
}

run();
