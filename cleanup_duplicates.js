const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function cleanup() {
  console.log("Loading all stats...");
  const { data: stats, error } = await supabase.from('video_stats').select('*').order('recorded_at', { ascending: true });
  
  if (error) return console.error(error);
  
  console.log(`Found total ${stats.length} rows. Analyzing duplicates...`);
  
  const uniqueKeys = new Set();
  const toDelete = [];
  
  for (const row of stats) {
    // unique key is combination of video_id and timestamp
    const key = `${row.video_id}_${row.recorded_at}`;
    
    if (uniqueKeys.has(key)) {
      toDelete.push(row.id);
    } else {
      uniqueKeys.add(key);
    }
  }
  
  if (toDelete.length === 0) {
    console.log("No duplicates found. Perfect database integrity!");
    return;
  }
  
  console.log(`Found ${toDelete.length} duplicate rows to delete.`);
  
  // Delete the specific redundant row IDs
  for (const id of toDelete) {
    console.log(`Deleting row ${id}...`);
    await supabase.from('video_stats').delete().eq('id', id);
  }
  
  console.log("Cleanup complete. Database is now clean!");
}

cleanup();
