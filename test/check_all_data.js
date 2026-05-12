const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAllData() {
  console.log("=== Checking Videos Table ===");
  const { data: videos, error: vErr } = await supabase.from('videos').select('*');
  if (vErr) console.error("Error fetching videos:", vErr);
  else {
    videos.forEach(v => {
      console.log(`- ${v.id}: ${v.title} (Published: ${v.published_at})`);
    });
  }

  console.log("\n=== Checking Video Stats Table ===");
  const { data: stats, error: sErr } = await supabase
    .from('video_stats')
    .select('*')
    .order('video_id', { ascending: true })
    .order('recorded_at', { ascending: true });

  if (sErr) console.error("Error fetching stats:", sErr);
  else {
    let currentVideo = "";
    stats.forEach(s => {
      if (currentVideo !== s.video_id) {
        currentVideo = s.video_id;
        console.log(`\nVideo: ${currentVideo}`);
      }
      const d = new Date(s.recorded_at);
      const jstDate = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      // Format as YYYY-MM-DD to easily check uniqueness per day
      const yyyymmdd = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
      
      console.log(`  [${s.id}] Date(JST): ${jstDate} | yyyy-mm-dd: ${yyyymmdd} | Views: ${s.views} | Likes: ${s.likes} | Mylists: ${s.mylists} | Comments: ${s.comments}`);
    });
  }
}

checkAllData();
