require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionsBitField,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const PREFIX = process.env.BOT_PREFIX || '!';
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;

// In-memory store of pending verifications: { discordId: { username, code } }
const pendingVerifications = new Map();

// Utility: generate a short verification code
function generateCode() {
  const num = Math.floor(10000 + Math.random() * 90000);
  return `JAIME-${num}`;
}

// TikTok bio fetcher with cache-busting for mobile app sync issues
// NOTE: TikTok HTML can change. Treat this as a placeholder / starting point.
async function fetchTikTokBio(username, retryCount = 0) {
  const cleanUser = username.replace(/^@/, '').trim();
  
  // Add cache-busting parameter to try to get fresh data
  const cacheBuster = Date.now();
  const url = `https://www.tiktok.com/@${cleanUser}?_cb=${cacheBuster}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    },
  });

  if (!res.ok) {
    console.error(`Failed to fetch TikTok profile: ${res.status}`);
    return null;
  }

  const html = await res.text();

  // Try multiple patterns to find the bio - TikTok uses different formats
  let bio = null;
  
  // Pattern 1: "signature":"..."
  const match1 = html.match(/"signature":"(.*?)"/);
  if (match1) {
    bio = match1[1];
  }
  
  // Pattern 2: "desc":"..." (alternate key)
  if (!bio) {
    const match2 = html.match(/"desc":"(.*?)"/);
    if (match2) bio = match2[1];
  }
  
  // Pattern 3: Look in userInfo object
  if (!bio) {
    const match3 = html.match(/"userInfo":\s*\{[^}]*"signature":"(.*?)"/);
    if (match3) bio = match3[1];
  }

  if (!bio) {
    console.log(`Could not find bio for @${cleanUser}`);
    return null;
  }

  // Unescape \uXXXX and \\" etc.
  bio = bio.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  // Convert \uXXXX
  bio = bio.replace(/\\u([\dA-Fa-f]{4})/g, (_, g1) =>
    String.fromCharCode(parseInt(g1, 16)),
  );

  console.log(`Fetched bio for @${cleanUser}: "${bio.substring(0, 50)}..."`);
  return bio;
}

// Retry function with delays for mobile app sync issues
async function fetchTikTokBioWithRetry(username, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const bio = await fetchTikTokBio(username, i);
    if (bio) return bio;
    
    // Wait a bit before retrying (1s, 2s, 3s)
    if (i < maxRetries - 1) {
      await new Promise(r => setTimeout(r, (i + 1) * 1000));
    }
  }
  return null;
}

// When bot is ready
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

// Simple text command: !setup-verify
// This lets you (admin) create the panel in a channel
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [command] = message.content.slice(PREFIX.length).trim().split(/\s+/);

  if (command.toLowerCase() === 'setup-verify') {
    // Only allow admins to run this
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply("You don't have permission to use this.");
    }

    const verifyButton = new ButtonBuilder()
      .setCustomId('verify_tiktok_start')
      .setLabel('Verify TikTok')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(verifyButton);

    await message.channel.send({
      content:
        '👋 **TikTok Verification**\n\nVerify your TikTok account to link your identity across platforms.\n\nClick the button below to start verification.\n\nOnce verified, you\'ll receive the **Verified Viewer** role.\n\n💀 Click below to begin:',
      components: [row],
    });

    await message.reply('Verification panel created.');
  }
});

// Handle interactions (buttons + modals)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button: start verification
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_tiktok_start') {
        const modal = new ModalBuilder()
          .setCustomId('verify_tiktok_modal')
          .setTitle('Verify Your TikTok');

        const usernameInput = new TextInputBuilder()
          .setCustomId('tiktok_username')
          .setLabel('Your TikTok username (e.g. @yourname)')
          .setPlaceholder('@yourname')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(usernameInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
      }

      if (interaction.customId === 'verify_tiktok_check') {
        // User clicked "I Added the Code"
        const record = pendingVerifications.get(interaction.user.id);
        if (!record) {
          return interaction.reply({
            content:
              'I could not find a pending verification for you. Please start again.',
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });

        await interaction.editReply('🔍 Checking your TikTok bio... (this may take a few seconds for mobile changes to sync)');

        const bio = await fetchTikTokBioWithRetry(record.username, 3);
        if (!bio) {
          return interaction.editReply(
            '❌ I could not read your TikTok profile.\n\n**Troubleshooting:**\n• Make sure your profile is **public** (not private)\n• If you edited on mobile, wait 1-2 minutes for TikTok to sync\n• Try opening your profile on tiktok.com to force a refresh\n• Then click **"I Added the Code"** again',
          );
        }

        if (bio.includes(record.code)) {
          // Verified
          pendingVerifications.delete(interaction.user.id);

          const member = await interaction.guild.members.fetch(
            interaction.user.id,
          );
          const role = interaction.guild.roles.cache.get(VERIFIED_ROLE_ID);

          if (!role) {
            await interaction.editReply(
              'I verified your TikTok, but the Verified role is not configured correctly. Please contact a mod.',
            );
            return;
          }

          await member.roles.add(role);

          await interaction.editReply(
            `🎉 Verification successful!\n\nI found the code **${record.code}** in the bio of **@${record.username}**.\nYou've been given the **Verified Viewer** role.\n\nYou can remove the code from your TikTok bio now. 💀`,
          );
        } else {
          await interaction.editReply(
            `⚠️ I could not find the verification code in the bio for **@${record.username}**.\n\n**Make sure:**\n• Your profile is **public**\n• Your bio contains exactly: \`${record.code}\`\n\n**📱 If you edited on mobile:**\nTikTok can take 1-2 minutes to sync changes to their website. Try:\n1. Open your profile on **tiktok.com** in a browser\n2. Refresh the page to see if your bio updated\n3. Then click **"I Added the Code"** again\n\nThe code is case-sensitive!`,
          );
        }
      }
    }

    // Modal submit
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'verify_tiktok_modal') {
        const username = interaction.fields
          .getTextInputValue('tiktok_username')
          .trim();

        const code = generateCode();
        pendingVerifications.set(interaction.user.id, {
          username: username.replace(/^@/, ''),
          code,
        });

        const checkButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_check')
          .setLabel('I Added the Code')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(checkButton);

        await interaction.reply({
          content: `Great! We're verifying your TikTok.\n\nTikTok username: **${username}**\n\nPlease temporarily add this code to your TikTok bio:\n\`\`\`\n${code}\n\`\`\`\nOnce it's in your bio, click **"I Added the Code"** below and I'll check it.\n\nIf you change your mind, you can ignore this and nothing will happen.`,
          components: [row],
          ephemeral: true,
        });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content:
            'Something went wrong while handling that interaction. Please try again or contact a moderator.',
          ephemeral: true,
        });
      } catch {
        // ignore double reply errors
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
