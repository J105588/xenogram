const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function debugDates() {
  const { data } = await supabase.from('video_stats').select('*').limit(10);
  console.log("Raw Supabase date values:");
  data.forEach(r => {
    console.log(`Video: ${r.video_id}, RecordedAt: ${r.recorded_at}`);
  });
}

debugDates();
