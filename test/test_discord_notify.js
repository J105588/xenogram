const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const channelId = process.env.DISCORD_CHANNEL_ID;

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}. Testing channel ID: ${channelId}`);
  try {
    if (!channelId) throw new Error("DISCORD_CHANNEL_ID is missing in .env!");
    
    console.log("Attempting to fetch channel...");
    const channel = await client.channels.fetch(channelId);
    
    if (!channel) {
      console.error("❌ Channel found is NULL. Bot may not have access to this channel.");
      process.exit(1);
    }
    
    console.log(`✅ Channel found: ${channel.name} (Type: ${channel.type})`);
    
    console.log("Attempting to send test message...");
    const embed = new EmbedBuilder().setTitle("Bot Connection Test").setDescription("Testing notification channel.").setColor(0x00ff00);
    const sent = await channel.send({ embeds: [embed] });
    
    console.log(`🎉 Success! Message sent with ID: ${sent.id}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ FAILED TO SEND NOTIFICATION!");
    console.error(err);
    process.exit(1);
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN!");
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
