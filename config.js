require('dotenv').config();

module.exports = {
  NICO_USER_ID: "143305795", // 対象のニコニコユーザーID
  CHART_COLOR: "3498db", // XENOGRAMブランドカラー (Hex)
  FOOTER_TEXT: "XENOGRAM Analytics",
  
  // Environment variables
  DISCORD: {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    GUILD_ID: process.env.DISCORD_GUILD_ID, // 開発用
    CHANNEL_ID: process.env.DISCORD_CHANNEL_ID, // 通知を送信するチャンネルID
  },
  SUPABASE: {
    URL: process.env.SUPABASE_URL,
    KEY: process.env.SUPABASE_KEY,
  },
  PORT: process.env.PORT || 3000,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
};
