require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
  EmbedBuilder,
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
const VERIFIED_USERS_FILE = path.join(__dirname, 'verified-users.json');

// In-memory store of pending verifications: { discordId: { username, code, guildId } }
const pendingVerifications = new Map();

// Cache for server prefixes: { guildId: prefix }
const serverPrefixes = new Map();

// Load verified users from file
function loadVerifiedUsers() {
  try {
    if (fs.existsSync(VERIFIED_USERS_FILE)) {
      const data = fs.readFileSync(VERIFIED_USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading verified users:', err);
  }
  return {};
}

// Save verified users to file
function saveVerifiedUsers(users) {
  try {
    fs.writeFileSync(VERIFIED_USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving verified users:', err);
  }
}

// Add a verified user
function addVerifiedUser(guildId, discordId, discordTag, tiktokUsername) {
  const users = loadVerifiedUsers();
  if (!users[guildId]) {
    users[guildId] = [];
  }
  
  // Check if already verified (update if so)
  const existing = users[guildId].findIndex(u => u.discordId === discordId);
  const userData = {
    discordId,
    discordTag,
    tiktokUsername,
    verifiedAt: new Date().toISOString(),
  };
  
  if (existing >= 0) {
    users[guildId][existing] = userData;
  } else {
    users[guildId].push(userData);
  }
  
  saveVerifiedUsers(users);
}

// Get verified users for a guild
function getVerifiedUsers(guildId) {
  const users = loadVerifiedUsers();
  return users[guildId] || [];
}

// Get a short prefix from a name (first word, uppercase, max 10 chars)
function getNamePrefix(name) {
  // Get first word, remove special characters, uppercase
  const clean = name.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return clean.substring(0, 10) || 'VERIFY';
}

// Get or fetch the server's verification prefix
async function getServerPrefix(guild) {
  if (serverPrefixes.has(guild.id)) {
    return serverPrefixes.get(guild.id);
  }
  
  try {
    // Try to get owner's display name
    const owner = await guild.fetchOwner();
    const prefix = getNamePrefix(owner.displayName || owner.user.username);
    serverPrefixes.set(guild.id, prefix);
    return prefix;
  } catch (err) {
    // Fall back to server name
    const prefix = getNamePrefix(guild.name);
    serverPrefixes.set(guild.id, prefix);
    return prefix;
  }
}

// Utility: generate a short verification code with server-specific prefix
async function generateCode(guild) {
  const prefix = await getServerPrefix(guild);
  const num = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${num}`;
}

// TikTok bio fetcher with cache-busting for mobile app sync issues
// Uses multiple strategies to bypass TikTok's aggressive caching
async function fetchTikTokBio(username, attemptNum = 0) {
  const cleanUser = username.replace(/^@/, '').trim();
  
  // Rotate user agents to try different cache layers
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ];
  
  const userAgent = userAgents[attemptNum % userAgents.length];
  
  // Add multiple cache-busting parameters
  const cacheBuster = Date.now() + Math.random();
  const url = `https://www.tiktok.com/@${cleanUser}?_t=${cacheBuster}&_r=${attemptNum}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    if (!res.ok) {
      console.error(`Attempt ${attemptNum + 1}: Failed to fetch TikTok profile: ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Try multiple patterns to find the bio - TikTok uses different formats
    let bio = null;
    
    // Pattern 1: "signature":"..." (most common)
    const match1 = html.match(/"signature":"(.*?)"/);
    if (match1 && match1[1]) {
      bio = match1[1];
    }
    
    // Pattern 2: "desc":"..." (alternate key)
    if (!bio) {
      const match2 = html.match(/"desc":"(.*?)"/);
      if (match2 && match2[1]) bio = match2[1];
    }
    
    // Pattern 3: Look in userInfo object specifically
    if (!bio) {
      const match3 = html.match(/"userInfo":\s*\{[^}]*"signature":"([^"]+)"/);
      if (match3 && match3[1]) bio = match3[1];
    }
    
    // Pattern 4: bio-link JSON format
    if (!bio) {
      const match4 = html.match(/"bioLink":[^}]+,"signature":"([^"]+)"/);
      if (match4 && match4[1]) bio = match4[1];
    }

    if (!bio) {
      console.log(`Attempt ${attemptNum + 1}: Could not find bio for @${cleanUser}`);
      return null;
    }

    // Unescape \uXXXX and \\" etc.
    bio = bio.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    // Convert \uXXXX unicode escapes
    bio = bio.replace(/\\u([\dA-Fa-f]{4})/g, (_, g1) =>
      String.fromCharCode(parseInt(g1, 16)),
    );
    
    // Also handle \\n newlines
    bio = bio.replace(/\\n/g, '\n');

    console.log(`Attempt ${attemptNum + 1}: Fetched bio for @${cleanUser}: "${bio.substring(0, 80)}..."`);
    return bio;
  } catch (err) {
    console.error(`Attempt ${attemptNum + 1}: Error fetching TikTok profile:`, err.message);
    return null;
  }
}

// Retry function with progressive delays for mobile app sync issues
// TikTok's mobile app can take 30-60 seconds to sync bio changes to web
async function fetchTikTokBioWithRetry(username, maxRetries = 5) {
  let lastBio = null;
  
  for (let i = 0; i < maxRetries; i++) {
    const bio = await fetchTikTokBio(username, i);
    
    if (bio) {
      lastBio = bio;
      return bio;
    }
    
    // Progressive delays: 2s, 3s, 4s, 5s between retries
    if (i < maxRetries - 1) {
      const delay = (i + 2) * 1000;
      console.log(`Waiting ${delay}ms before retry ${i + 2}...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  return lastBio;
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

  // Command: !verified-list - Show all verified users (admin only)
  if (command.toLowerCase() === 'verified-list') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply("You don't have permission to use this.");
    }

    const verifiedUsers = getVerifiedUsers(message.guild.id);
    
    if (verifiedUsers.length === 0) {
      return message.reply('No verified users yet.');
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Verified Users')
      .setColor(0x43b581)
      .setDescription(`Total: **${verifiedUsers.length}** verified users`)
      .setTimestamp();

    // Add users to embed (max 25 fields)
    const usersToShow = verifiedUsers.slice(0, 25);
    const userList = usersToShow.map((u, i) => 
      `**${i + 1}.** <@${u.discordId}> → [@${u.tiktokUsername}](https://tiktok.com/@${u.tiktokUsername})`
    ).join('\n');

    embed.addFields({ name: 'Linked Accounts', value: userList || 'None' });

    if (verifiedUsers.length > 25) {
      embed.setFooter({ text: `Showing 25 of ${verifiedUsers.length} users` });
    }

    await message.reply({ embeds: [embed] });
  }

  // Command: !verified-export - Export as CSV (admin only)
  if (command.toLowerCase() === 'verified-export') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply("You don't have permission to use this.");
    }

    const verifiedUsers = getVerifiedUsers(message.guild.id);
    
    if (verifiedUsers.length === 0) {
      return message.reply('No verified users to export.');
    }

    const csv = 'Discord ID,Discord Tag,TikTok Username,Verified At\n' + 
      verifiedUsers.map(u => 
        `${u.discordId},${u.discordTag},@${u.tiktokUsername},${u.verifiedAt}`
      ).join('\n');

    const buffer = Buffer.from(csv, 'utf8');
    
    await message.reply({
      content: `📊 Exported ${verifiedUsers.length} verified users:`,
      files: [{
        attachment: buffer,
        name: `verified-users-${message.guild.id}.csv`
      }]
    });
  }
});

// Handle interactions (buttons + modals)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button: start verification - generate code first
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_tiktok_start') {
        // Generate code immediately
        const code = await generateCode(interaction.guild);
        
        // Store the code for this user
        pendingVerifications.set(interaction.user.id, {
          code,
          guildId: interaction.guild.id,
        });

        // Show code and button to continue
        const continueButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_added')
          .setLabel('I Added the Code - Enter My Profile')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(continueButton);

        await interaction.reply({
          content: `🔐 **Step 1: Add this code to your TikTok bio**\n\nYour unique verification code:\n\`\`\`\n${code}\n\`\`\`\n\n**Instructions:**\n1. Open TikTok and go to your profile\n2. Tap "Edit profile"\n3. Add the code at the **beginning** of your bio\n4. Save your profile\n5. Click the button below\n\n⏳ You can remove the code after verification is complete.\n\n📱 **Note:** When you update your bio on mobile, it can take **30-60+ seconds** for TikTok's web servers to reflect the change.`,
          components: [row],
          ephemeral: true,
        });
      }

      // Button: user says they added the code, now ask for profile link
      if (interaction.customId === 'verify_tiktok_added') {
        const record = pendingVerifications.get(interaction.user.id);
        if (!record) {
          return interaction.reply({
            content: 'I could not find a pending verification for you. Please start again.',
            ephemeral: true,
          });
        }

        const modal = new ModalBuilder()
          .setCustomId('verify_tiktok_link_modal')
          .setTitle('Enter Your TikTok Profile');

        const linkInput = new TextInputBuilder()
          .setCustomId('tiktok_link')
          .setLabel('Your TikTok profile link or username')
          .setPlaceholder('https://tiktok.com/@yourname or @yourname')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(linkInput);
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

        await interaction.editReply('🔍 **Checking your TikTok bio...**\n\n⏳ This can take up to **30 seconds** due to TikTok\'s servers syncing.\nPlease wait...');

        // Use 5 retries with progressive delays to handle TikTok caching
        const bio = await fetchTikTokBioWithRetry(record.username, 5);
        if (!bio) {
          return interaction.editReply(
            '❌ I could not read your TikTok profile.\n\n**Troubleshooting:**\n• Make sure your profile is **public** (not private)\n• If you edited on mobile, wait 1-2 minutes for TikTok to sync\n• Try opening your profile on tiktok.com to force a refresh\n• Then click **"I Added the Code"** again',
          );
        }

        // Check if code is in bio (case-insensitive to handle edge cases)
        const bioUpper = bio.toUpperCase();
        const codeUpper = record.code.toUpperCase();
        
        if (bioUpper.includes(codeUpper)) {
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

          // Save to verified users list
          addVerifiedUser(
            interaction.guild.id,
            interaction.user.id,
            interaction.user.tag,
            record.username
          );

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
      // New flow: user submits their profile link
      if (interaction.customId === 'verify_tiktok_link_modal') {
        const linkInput = interaction.fields
          .getTextInputValue('tiktok_link')
          .trim();

        // Extract username from link or raw input
        let username = linkInput;
        // Handle full URLs like https://tiktok.com/@username or tiktok.com/@username
        const urlMatch = linkInput.match(/tiktok\.com\/@?([a-zA-Z0-9_.]+)/i);
        if (urlMatch) {
          username = urlMatch[1];
        } else {
          // Clean up @ symbol if provided
          username = username.replace(/^@/, '');
        }

        const record = pendingVerifications.get(interaction.user.id);
        if (!record) {
          return interaction.reply({
            content: 'I could not find a pending verification for you. Please start again.',
            ephemeral: true,
          });
        }

        // Update record with username
        record.username = username;
        pendingVerifications.set(interaction.user.id, record);

        const checkButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_check')
          .setLabel('Verify Now')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(checkButton);

        await interaction.reply({
          content: `📋 **Step 2: Verify your profile**\n\nTikTok username: **@${username}**\nVerification code: \`${record.code}\`\n\nMake sure the code is in your bio, then click **"Verify Now"**.\n\n📱 **Note:** When you update your bio on mobile, it can take **30-60+ seconds** for TikTok's web servers to reflect the change. Please wait before clicking Verify Now.`,
          components: [row],
          ephemeral: true,
        });
      }

      // Old flow (keeping for backwards compatibility)
      if (interaction.customId === 'verify_tiktok_modal') {
        const username = interaction.fields
          .getTextInputValue('tiktok_username')
          .trim();

        const code = await generateCode(interaction.guild);
        pendingVerifications.set(interaction.user.id, {
          username: username.replace(/^@/, ''),
          code,
          guildId: interaction.guild.id,
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
