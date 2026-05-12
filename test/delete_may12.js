const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function deleteMay12() {
  console.log("Looking for records on May 12 (JST)...");
  
  // 5月12日の日本時間 00:00:00 〜 23:59:59
  const startOfDay = new Date(2026, 4, 12, 0, 0, 0, 0).toISOString(); // month is 0-indexed (4 = May)
  const endOfDay = new Date(2026, 4, 12, 23, 59, 59, 999).toISOString();

  console.log(`Bounds (UTC): ${startOfDay} to ${endOfDay}`);

  const { data: records, error: fetchErr } = await supabase
    .from('video_stats')
    .select('id, video_id, recorded_at')
    .gte('recorded_at', startOfDay)
    .lte('recorded_at', endOfDay);

  if (fetchErr) {
    console.error("Fetch error:", fetchErr);
    return;
  }

  if (!records || records.length === 0) {
    console.log("No records found for May 12.");
    return;
  }

  console.log(`Found ${records.length} records. Deleting...`);
  
  for (const record of records) {
    const jst = new Date(record.recorded_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`Deleting ID ${record.id} for ${record.video_id} (Recorded: ${jst})`);
    
    const { error: delErr } = await supabase.from('video_stats').delete().eq('id', record.id);
    if (delErr) {
      console.error(`Failed to delete ${record.id}:`, delErr);
    }
  }

  console.log("Done.");
}

// Ensure TZ is Asia/Tokyo for correct bounds calculation
process.env.TZ = 'Asia/Tokyo';
deleteMay12();
