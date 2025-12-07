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

// In-memory store of pending verifications: { discordId: { username, code, previousCodes, guildId } }
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

// TikTok bio fetcher - uses Android mobile Chrome user agent
// Based on https://github.com/rxxv/TiktokAccountInfo approach
// Extracts data from embedded JSON in page (more reliable than HTML parsing)
async function fetchTikTokBio(username, attemptNum = 0) {
  const cleanUser = username.replace(/^@/, '').trim();
  
  // Headers that mimic Android Chrome browser - more reliable than TikTok app UA
  const headers = {
    'Host': 'www.tiktok.com',
    'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="99", "Google Chrome";v="99"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'upgrade-insecure-requests': '1',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 8.0.0; Plume L2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.88 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  const url = `https://www.tiktok.com/@${cleanUser}`;

  try {
    const res = await fetch(url, { headers });

    if (!res.ok) {
      console.error(`Attempt ${attemptNum + 1}: Failed to fetch TikTok profile: ${res.status}`);
      return null;
    }

    const html = await res.text();
    let bio = null;

    // Method 1: Try to extract from embedded JSON (most reliable)
    // TikTok embeds user data in a script tag as JSON
    try {
      // Look for the userInfo in the embedded JSON
      const jsonMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
      if (jsonMatch) {
        const jsonData = JSON.parse(jsonMatch[1]);
        const userInfo = jsonData?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo;
        if (userInfo?.user?.signature) {
          bio = userInfo.user.signature;
          console.log(`Attempt ${attemptNum + 1}: Got bio from REHYDRATION JSON for @${cleanUser}`);
        }
      }
    } catch (jsonErr) {
      // JSON parsing failed, fall back to regex
    }

    // Method 2: Try SIGI_STATE format (older format)
    if (!bio) {
      try {
        const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([^<]+)<\/script>/);
        if (sigiMatch) {
          const jsonData = JSON.parse(sigiMatch[1]);
          const userModule = jsonData?.UserModule?.users;
          if (userModule) {
            const userKey = Object.keys(userModule)[0];
            if (userKey && userModule[userKey]?.signature) {
              bio = userModule[userKey].signature;
              console.log(`Attempt ${attemptNum + 1}: Got bio from SIGI_STATE for @${cleanUser}`);
            }
          }
        }
      } catch (sigiErr) {
        // SIGI parsing failed
      }
    }

    // Method 3: Fallback to regex patterns
    if (!bio) {
      // Pattern 1: "signature":"..." (most common)
      const match1 = html.match(/"signature":"(.*?)"/);
      if (match1 && match1[1]) {
        bio = match1[1];
        console.log(`Attempt ${attemptNum + 1}: Got bio from regex for @${cleanUser}`);
      }
    }
    
    // Pattern 2: Look for userInfo object specifically
    if (!bio) {
      const match2 = html.match(/"userInfo":\s*\{[^}]*"signature":"([^"]+)"/);
      if (match2 && match2[1]) bio = match2[1];
    }

    if (!bio) {
      console.log(`Attempt ${attemptNum + 1}: Could not find bio for @${cleanUser}`);
      return null;
    }

    // Unescape unicode and special characters
    bio = bio.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    bio = bio.replace(/\\u([\dA-Fa-f]{4})/g, (_, g1) =>
      String.fromCharCode(parseInt(g1, 16)),
    );
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
}

// Health check - test that we can still read TikTok bios
async function runHealthCheck() {
  const testAccount = 'tiktok'; // Official TikTok account - always exists
  console.log(`[Health Check] Testing TikTok bio fetch for @${testAccount}...`);
  
  const bio = await fetchTikTokBio(testAccount, 0);
  
  if (bio) {
    console.log(`[Health Check] ✅ SUCCESS - Can read TikTok bios. Bio: "${bio.substring(0, 50)}..."`);
    return { success: true, bio };
  } else {
    console.error(`[Health Check] ❌ FAILED - Cannot read TikTok bios! TikTok may be blocking requests.`);
    return { success: false, bio: null };
  }
}

// Schedule periodic health checks (every 4 hours)
function startHealthCheckScheduler() {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  
  // Run initial check after 1 minute
  setTimeout(async () => {
    await runHealthCheck();
  }, 60 * 1000);
  
  // Then run every 4 hours
  setInterval(async () => {
    await runHealthCheck();
  }, FOUR_HOURS);
  
  console.log('[Health Check] Scheduler started - will check every 4 hours');
}

// When bot is ready
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  
  // Start health check scheduler
  startHealthCheckScheduler();
});

// Simple text command: !setup-verify
// This lets you (admin) create the panel in a channel
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [command, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);

  // Command: !test-tiktok [@username] - Test if bot can read TikTok bios (admin only)
  if (command.toLowerCase() === 'test-tiktok') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply("You don't have permission to use this.");
    }

    const testUser = args[0] ? args[0].replace(/^@/, '') : 'tiktok';
    const statusMsg = await message.reply(`🔍 Testing TikTok bio fetch for **@${testUser}**...`);
    
    const bio = await fetchTikTokBio(testUser, 0);
    
    if (bio) {
      await statusMsg.edit(`✅ **Success!** Can read TikTok bios.\n\n**@${testUser}'s bio:**\n> ${bio.substring(0, 200)}${bio.length > 200 ? '...' : ''}`);
    } else {
      await statusMsg.edit(`❌ **Failed!** Cannot read TikTok bio for @${testUser}.\n\nPossible issues:\n• TikTok may be blocking requests\n• The profile may be private\n• The username may not exist`);
    }
    return;
  }

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

  // Command: !manual-verify @user @tiktokUsername - Manually verify a user (admin only)
  if (command.toLowerCase() === 'manual-verify') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply("You don't have permission to use this.");
    }

    const mentionedUser = message.mentions.users.first();
    const tiktokUsername = args[1]?.replace(/^@/, '') || args[0]?.replace(/^@/, '');

    if (!mentionedUser) {
      return message.reply('Usage: `!manual-verify @DiscordUser @tiktokUsername`\n\nExample: `!manual-verify @Bea @penny.the.french.girl`');
    }

    if (!tiktokUsername || tiktokUsername.startsWith('<@')) {
      return message.reply('Please provide a TikTok username.\n\nUsage: `!manual-verify @DiscordUser @tiktokUsername`');
    }

    try {
      const member = await message.guild.members.fetch(mentionedUser.id);
      const role = message.guild.roles.cache.get(VERIFIED_ROLE_ID);

      if (!role) {
        return message.reply('❌ Verified role not found. Check VERIFIED_ROLE_ID in your .env');
      }

      await member.roles.add(role);

      // Save to verified users list
      addVerifiedUser(
        message.guild.id,
        mentionedUser.id,
        mentionedUser.tag,
        tiktokUsername
      );

      await message.reply(`✅ Manually verified **${mentionedUser.tag}** with TikTok **@${tiktokUsername}**\n\nThey now have the Verified role.`);
    } catch (err) {
      console.error('Manual verify error:', err);
      await message.reply(`❌ Error: ${err.message}`);
    }
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
        
        // Get existing record to preserve previous codes
        const existingRecord = pendingVerifications.get(interaction.user.id);
        const previousCodes = existingRecord?.previousCodes || [];
        
        // Add current code to previous codes (keep last 2)
        if (existingRecord?.code) {
          previousCodes.unshift(existingRecord.code);
          if (previousCodes.length > 2) previousCodes.pop();
        }
        
        // Store the code for this user with previous codes
        pendingVerifications.set(interaction.user.id, {
          code,
          previousCodes,
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

        await interaction.editReply('🔍 **Checking your TikTok bio...**\n\n⏳ TikTok can take a while to sync bio changes.\nI\'ll keep checking for up to **10 minutes**. Please wait...');

        // Poll for up to 10 minutes (60 attempts, 10 seconds apart)
        const maxAttempts = 60;
        const delayBetweenAttempts = 10000; // 10 seconds
        let verified = false;
        let lastBio = null;
        let foundCode = null;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const bio = await fetchTikTokBio(record.username, attempt);
          
          if (bio) {
            lastBio = bio;
            const bioUpper = bio.toUpperCase();
            
            // Check current code AND previous 2 codes (handles TikTok CDN lag)
            const allCodes = [record.code, ...(record.previousCodes || [])];
            let matchedCode = null;
            
            for (const code of allCodes) {
              if (bioUpper.includes(code.toUpperCase())) {
                matchedCode = code;
                break;
              }
            }
            
            console.log(`[VERIFY] Attempt ${attempt}/${maxAttempts} - Bio: "${bio.substring(0, 50)}..." - Checking codes: ${allCodes.join(', ')} - Matched: ${matchedCode || 'none'}`);
            
            if (matchedCode) {
              verified = true;
              foundCode = matchedCode;
              break;
            }
          } else {
            console.log(`[VERIFY] Attempt ${attempt}/${maxAttempts} - Could not fetch bio`);
          }
          
          // Update user on progress every 30 seconds (every 3 attempts)
          if (attempt % 3 === 0 && attempt < maxAttempts) {
            const minutesLeft = Math.ceil((maxAttempts - attempt) * delayBetweenAttempts / 60000);
            await interaction.editReply(`🔍 **Still checking your TikTok bio...**\n\n⏳ Attempt ${attempt}/${maxAttempts} - Checking for up to ${minutesLeft} more minute(s).\nTikTok CDN can be slow to update. Please wait...`);
          }
          
          // Wait before next attempt (except on last attempt)
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, delayBetweenAttempts));
          }
        }
        
        // Debug logging
        console.log(`[VERIFY] User: ${interaction.user.tag}`);
        console.log(`[VERIFY] TikTok: @${record.username}`);
        console.log(`[VERIFY] Expected code: ${record.code}`);
        console.log(`[VERIFY] Final bio: "${lastBio}"`);
        console.log(`[VERIFY] Verified: ${verified}`);
        
        if (!lastBio) {
          console.log(`[VERIFY] FAILED - No bio returned`);
          return interaction.editReply(
            '❌ I could not read your TikTok profile.\n\n**Troubleshooting:**\n• Make sure your profile is **public** (not private)\n• If you edited on mobile, wait 1-2 minutes for TikTok to sync\n• Try opening your profile on tiktok.com to force a refresh\n• Then click **"I Added the Code"** again',
          );
        }

        if (verified) {
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
            `🎉 Verification successful!\n\nI found the code **${foundCode}** in the bio of **@${record.username}**.\nYou've been given the **Verified Viewer** role.\n\nYou can remove the code from your TikTok bio now. 💀`,
          );
        } else {
          const allCodes = [record.code, ...(record.previousCodes || [])];
          await interaction.editReply(
            `⚠️ I could not find the verification code after checking for 10 minutes.\n\n**Profile:** @${record.username}\n**Accepted codes:** ${allCodes.map(c => '\`' + c + '\`').join(', ')}\n\n**Make sure:**\n• Your profile is **public**\n• Your bio contains one of the codes above\n• You saved the bio changes on TikTok\n\n**Still not working?** Ask an admin to use \`!manual-verify\` to verify you manually.`,
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
        
        // Handle full URLs like https://tiktok.com/@username or https://www.tiktok.com/@username
        // Also handles: tiktok.com/@user, www.tiktok.com/@user, vm.tiktok.com/xxx
        const urlMatch = linkInput.match(/(?:https?:\/\/)?(?:www\.|vm\.)?tiktok\.com\/@([a-zA-Z0-9_.]+)/i);
        if (urlMatch) {
          username = urlMatch[1];
        } else {
          // Not a URL - clean up @ symbol if provided and remove any URL parts
          username = username
            .replace(/^@/, '')                    // Remove leading @
            .replace(/https?:\/\//gi, '')         // Remove http:// or https://
            .replace(/www\.tiktok\.com\/?/gi, '') // Remove www.tiktok.com
            .replace(/tiktok\.com\/?/gi, '')      // Remove tiktok.com
            .replace(/^@/, '')                    // Remove @ again after URL removal
            .trim();
        }
        
        console.log(`[USERNAME PARSE] Input: "${linkInput}" -> Username: "${username}"`);

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
