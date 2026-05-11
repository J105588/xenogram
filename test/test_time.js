const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkNow() {
  const { data, error } = await supabase.rpc('version'); // Just a trigger or raw select
  // Let's use a real table query to get CURRENT_TIMESTAMP from PostgreSQL
  const { data: timeData } = await supabase.from('videos').select('id').limit(1);
  // Wait, the simplest way to run RAW SQL in Supabase is RPC or checking user object...
  // Actually I can't run arbitrary SQL without a custom RPC function.
  // I will just read a timestamp from the DB directly.
  const { data: rows } = await supabase.from('video_stats').select('recorded_at').limit(1).order('recorded_at', { ascending: false });
  console.log("Latest recorded_at:", rows[0].recorded_at);
}

checkNow();
