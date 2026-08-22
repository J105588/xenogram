const { createClient } = require('@supabase/supabase-js');
const config = require('../../config');

const supabaseUrl = config.SUPABASE.URL;
const supabaseKey = config.SUPABASE.KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase URL or Key is not set. Database features will fail.");
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

module.exports = { supabase };
