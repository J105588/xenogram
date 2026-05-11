const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function analyze() {
  const vid = 'sm45971249';
  console.log(`Analyzing full history for ${vid}...`);
  
  const { data: rows, error } = await supabase
    .from('video_stats')
    .select('*')
    .eq('video_id', vid)
    .order('recorded_at', { ascending: true });
    
  if (error) return console.error(error);
  
  console.log(`Found ${rows.length} rows in DB for this video.`);
  
  rows.forEach((r, i) => {
    const d = new Date(r.recorded_at);
    const jst = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`Row ${i+1}: DB=${r.recorded_at}  =>  JST=${jst}`);
  });
  
  // Let's also simulate what the Bot does when generating a chart:
  console.log("\nSimulation of Chart Array construction:");
  const history = rows.map(r => ({ views: r.views, recorded_at: r.recorded_at }));
  
  // Add the "live fetch" pushed element
  const liveFetchDate = new Date().toISOString();
  history.push({ views: 999, recorded_at: liveFetchDate });
  
  console.log("Pushed Live Fetch:", liveFetchDate, " => JST:", new Date(liveFetchDate).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
  
  // Now reproduce the utils.js label extraction
  console.log("\nFinal Chart Labels (Asia/Tokyo):");
  for (let i = 1; i < history.length; i++) {
    const curr = history[i];
    const d = new Date(curr.recorded_at);
    const m = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit' });
    const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', day: '2-digit' });
    console.log(`Label ${i}: ${m}/${day}`);
  }
}

analyze();
