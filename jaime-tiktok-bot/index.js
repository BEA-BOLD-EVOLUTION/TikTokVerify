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

// Very naive TikTok bio fetcher using global fetch (Node 18+)
// NOTE: TikTok HTML can change. Treat this as a placeholder / starting point.
async function fetchTikTokBio(username) {
  const cleanUser = username.replace(/^@/, '').trim();
  const url = `https://www.tiktok.com/@${cleanUser}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    console.error(`Failed to fetch TikTok profile: ${res.status}`);
    return null;
  }

  const html = await res.text();

  // TikTok embeds bio/"signature" in JSON. This is a rough extraction.
  const match = html.match(/"signature":"(.*?)"/);
  if (!match) return null;

  // Unescape \uXXXX and \\" etc.
  let bio = match[1];
  bio = bio.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  // Convert \uXXXX
  bio = bio.replace(/\\u([\dA-Fa-f]{4})/g, (_, g1) =>
    String.fromCharCode(parseInt(g1, 16)),
  );

  return bio;
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
        '👋 **Welcome to Jaime\'s Server!**\n\nIf you came from TikTok LIVE, you can verify your TikTok account here so we know who\'s who and can assign the correct roles.\n\nClick the button below to start verification.\n\nOnce verified, you\'ll unlock:\n• Viewer community channels\n• Events and challenges\n• Jaime\'s announcements\n• Exclusive perks for verified members\n\nSuperfans have a separate verification path through TikTok.\n\n💀 Click below to begin:',
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

        const bio = await fetchTikTokBio(record.username);
        if (!bio) {
          return interaction.editReply(
            'I could not read your TikTok profile. Make sure it is public and try again later.',
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
            `⚠️ I could not find the verification code in the bio for **@${record.username}**.\n\nMake sure your profile is public and that your bio contains:\n\`${record.code}\`\n\nUpdate your bio and click **"I Added the Code"** again.`,
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
