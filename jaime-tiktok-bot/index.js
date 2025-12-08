require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
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
const SKU_ID = process.env.SKU_ID || '1447694080107876593'; // Subscription SKU ID
const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '804762166854942790'; // BEA's Discord user ID
const VERIFIED_USERS_FILE = path.join(__dirname, 'verified-users.json');
const PENDING_VERIFICATIONS_FILE = path.join(__dirname, 'pending-verifications.json');

// Redis connection (optional - falls back to file storage if not configured)
let redis = null;
const REDIS_PREFIX = 'tiktok_verify:';

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
  });
  
  redis.on('connect', () => {
    console.log('[Redis] Connected successfully');
  });
  
  redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });
}

// In-memory store of pending verifications: { discordId: { username, code, previousCodes, guildId } }
const pendingVerifications = new Map();

// Track users currently in active verification polling (to prevent multiple loops)
const activeVerifications = new Set();

// Cache for server prefixes: { guildId: prefix }
const serverPrefixes = new Map();

// Redis helper functions
async function redisSavePending(userId, data) {
  if (!redis) return false;
  try {
    await redis.set(`${REDIS_PREFIX}pending:${userId}`, JSON.stringify(data), 'EX', 86400); // 24 hour expiry
    return true;
  } catch (err) {
    console.error('[Redis] Save error:', err.message);
    return false;
  }
}

async function redisGetPending(userId) {
  if (!redis) return null;
  try {
    const data = await redis.get(`${REDIS_PREFIX}pending:${userId}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error('[Redis] Get error:', err.message);
    return null;
  }
}

async function redisDeletePending(userId) {
  if (!redis) return false;
  try {
    await redis.del(`${REDIS_PREFIX}pending:${userId}`);
    return true;
  } catch (err) {
    console.error('[Redis] Delete error:', err.message);
    return false;
  }
}

async function redisGetAllPending() {
  if (!redis) return {};
  try {
    const keys = await redis.keys(`${REDIS_PREFIX}pending:*`);
    if (keys.length === 0) return {};
    
    const result = {};
    for (const key of keys) {
      const userId = key.replace(`${REDIS_PREFIX}pending:`, '');
      const data = await redis.get(key);
      if (data) result[userId] = JSON.parse(data);
    }
    return result;
  } catch (err) {
    console.error('[Redis] Get all error:', err.message);
    return {};
  }
}

// Load pending verifications (from Redis or file)
async function loadPendingVerifications() {
  // Try Redis first
  if (redis) {
    try {
      await redis.connect();
      const all = await redisGetAllPending();
      for (const [key, value] of Object.entries(all)) {
        pendingVerifications.set(key, value);
      }
      console.log(`[Startup] Loaded ${pendingVerifications.size} pending verifications from Redis`);
      return;
    } catch (err) {
      console.error('[Redis] Failed to load, falling back to file:', err.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(PENDING_VERIFICATIONS_FILE)) {
      const data = fs.readFileSync(PENDING_VERIFICATIONS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      for (const [key, value] of Object.entries(parsed)) {
        pendingVerifications.set(key, value);
      }
      console.log(`[Startup] Loaded ${pendingVerifications.size} pending verifications from file`);
    }
  } catch (err) {
    console.error('Error loading pending verifications from file:', err);
  }
}

// Save pending verifications (to Redis and file)
async function savePendingVerifications() {
  // Save to Redis if available
  if (redis) {
    // Redis saves are done individually in set/delete operations
    return;
  }
  
  // Fallback: save to file
  try {
    const obj = Object.fromEntries(pendingVerifications);
    fs.writeFileSync(PENDING_VERIFICATIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Error saving pending verifications to file:', err);
  }
}

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

// Remove a verified user
function removeVerifiedUser(guildId, discordId) {
  const users = loadVerifiedUsers();
  if (!users[guildId]) return false;
  
  const index = users[guildId].findIndex(u => u.discordId === discordId);
  if (index >= 0) {
    const removed = users[guildId].splice(index, 1)[0];
    saveVerifiedUsers(users);
    console.log(`[UNVERIFY] Removed ${removed.discordTag} (${discordId}) | TikTok: @${removed.tiktokUsername} | Guild: ${guildId}`);
    return true;
  }
  return false;
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
// Returns: { bio: string|null, accountNotFound: boolean, emptyBio: boolean }
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
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  };

  // Add cache-busting query parameter to try to get fresh content
  const cacheBuster = Date.now();
  const url = `https://www.tiktok.com/@${cleanUser}?_cb=${cacheBuster}`;

  try {
    const res = await fetch(url, { headers });

    if (!res.ok) {
      console.error(`Attempt ${attemptNum + 1}: Failed to fetch TikTok profile: ${res.status}`);
      return null;
    }

    const html = await res.text();
    let bio = null;
    let accountNotFound = false;
    let emptyBio = false;

    // Check for account not found (statusCode 10221)
    try {
      const statusMatch = html.match(/"webapp\.user-detail":\s*\{"statusCode":(\d+)/);
      if (statusMatch && statusMatch[1] === '10221') {
        console.log(`Attempt ${attemptNum + 1}: Account @${cleanUser} not found (statusCode 10221)`);
        return { bio: null, accountNotFound: true, emptyBio: false };
      }
    } catch (e) {
      // Ignore parse errors
    }

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
      // Check if account exists but has empty bio
      const signatureMatch = html.match(/"signature":""/);
      if (signatureMatch) {
        console.log(`Attempt ${attemptNum + 1}: Account @${cleanUser} has empty bio`);
        return { bio: '', accountNotFound: false, emptyBio: true };
      }
      console.log(`Attempt ${attemptNum + 1}: Could not find bio for @${cleanUser}`);
      return { bio: null, accountNotFound: false, emptyBio: false };
    }

    // Unescape unicode and special characters
    bio = bio.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    bio = bio.replace(/\\u([\dA-Fa-f]{4})/g, (_, g1) =>
      String.fromCharCode(parseInt(g1, 16)),
    );
    bio = bio.replace(/\\n/g, '\n');

    console.log(`Attempt ${attemptNum + 1}: Fetched bio for @${cleanUser}: "${bio.substring(0, 80)}..."`);
    return { bio, accountNotFound: false, emptyBio: false };
  } catch (err) {
    console.error(`Attempt ${attemptNum + 1}: Error fetching TikTok profile:`, err.message);
    return { bio: null, accountNotFound: false, emptyBio: false };
  }
}

// Retry function with progressive delays for mobile app sync issues
// TikTok's mobile app can take 30-60 seconds to sync bio changes to web
async function fetchTikTokBioWithRetry(username, maxRetries = 5) {
  let lastResult = { bio: null, accountNotFound: false, emptyBio: false };
  
  for (let i = 0; i < maxRetries; i++) {
    const result = await fetchTikTokBio(username, i);
    
    // If account not found, return immediately
    if (result.accountNotFound) {
      return result;
    }
    
    if (result.bio) {
      return result;
    }
    
    lastResult = result;
    
    // Progressive delays: 2s, 3s, 4s, 5s between retries
    if (i < maxRetries - 1) {
      const delay = (i + 2) * 1000;
      console.log(`Waiting ${delay}ms before retry ${i + 2}...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  return lastResult;
}

// Health check - test that we can still read TikTok bios
async function runHealthCheck() {
  const testAccount = 'tiktok'; // Official TikTok account - always exists
  console.log(`[Health Check] Testing TikTok bio fetch for @${testAccount}...`);
  
  const result = await fetchTikTokBio(testAccount, 0);
  
  if (result.bio) {
    console.log(`[Health Check] ✅ SUCCESS - Can read TikTok bios. Bio: "${result.bio.substring(0, 50)}..."`);
    return { success: true, bio: result.bio };
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

// Background verification checker - runs every 2 hours to check all pending verifications
async function runBackgroundVerificationCheck() {
  console.log('[Background Verify] Starting check of all pending verifications...');
  
  // Sync from Redis first
  if (redis) {
    try {
      const keys = await redis.keys(`${REDIS_PREFIX}pending:*`);
      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          const discordId = key.replace(`${REDIS_PREFIX}pending:`, '');
          if (!pendingVerifications.has(discordId)) {
            pendingVerifications.set(discordId, parsed);
          }
        }
      }
    } catch (err) {
      console.error('[Background Verify] Error syncing from Redis:', err.message);
    }
  }

  const pending = Array.from(pendingVerifications.entries());
  console.log(`[Background Verify] Checking ${pending.length} pending verifications...`);

  for (const [discordId, record] of pending) {
    if (!record.username || record.username === 'undefined') {
      console.log(`[Background Verify] Skipping ${discordId} - no username in record`);
      continue;
    }

    try {
      // Try up to 10 times to fetch bio (different CDN servers may have different cache)
      let result = null;
      let lastBio = null;
      const maxAttempts = 10;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        result = await fetchTikTokBio(record.username, attempt - 1);
        
        if (result.accountNotFound) {
          break; // Account definitely doesn't exist
        }
        
        if (result.bio) {
          lastBio = result.bio;
          
          // Check if code is in bio
          const bioUpper = result.bio.toUpperCase();
          const allCodes = [record.code, ...(record.previousCodes || [])];
          let foundCode = false;
          
          for (const code of allCodes) {
            const codeUpper = code.toUpperCase();
            const typoVariant = codeUpper.replace('JAIME', 'JAMIE');
            
            if (bioUpper.includes(codeUpper) || bioUpper.includes(typoVariant)) {
              // Found it! No need to retry
              console.log(`[Background Verify] Found code on attempt ${attempt}`);
              foundCode = true;
              break;
            }
          }
          
          if (foundCode) break; // Stop retrying, we found it
        }
        
        // Wait 2 seconds before retry
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      
      if (result.accountNotFound) {
        console.log(`[Background Verify] ${discordId} (@${record.username}) - Account not found, removing from pending`);
        pendingVerifications.delete(discordId);
        if (redis) {
          await redisDeletePending(discordId);
        }
        continue;
      }
      
      if (!lastBio) {
        console.log(`[Background Verify] ${discordId} (@${record.username}) - Could not fetch bio after ${maxAttempts} attempts${result.emptyBio ? ' (bio is empty)' : ''}`);
        continue;
      }

      const bioUpper = lastBio.toUpperCase();
      const allCodes = [record.code, ...(record.previousCodes || [])];
      let matchedCode = null;

      for (const code of allCodes) {
        const codeUpper = code.toUpperCase();
        const typoVariant = codeUpper.replace('JAIME', 'JAMIE');
        
        if (bioUpper.includes(codeUpper) || bioUpper.includes(typoVariant)) {
          matchedCode = code;
          break;
        }
      }

      if (matchedCode) {
        console.log(`[Background Verify] ✅ MATCH FOUND! ${discordId} (@${record.username}) - Code: ${matchedCode}`);
        
        // Verify the user
        try {
          const guild = client.guilds.cache.get(record.guildId);
          if (!guild) {
            console.log(`[Background Verify] Could not find guild ${record.guildId}`);
            continue;
          }

          const member = await guild.members.fetch(discordId).catch(() => null);
          if (!member) {
            console.log(`[Background Verify] Could not find member ${discordId} in guild`);
            continue;
          }

          const role = guild.roles.cache.get(VERIFIED_ROLE_ID);
          if (!role) {
            console.log(`[Background Verify] Could not find verified role`);
            continue;
          }

          await member.roles.add(role);

          // Save to verified users list
          addVerifiedUser(record.guildId, discordId, member.user.tag, record.username);

          // Remove from pending
          pendingVerifications.delete(discordId);
          if (redis) {
            await redisDeletePending(discordId);
          } else {
            savePendingVerifications();
          }

          // Try to DM the user
          try {
            await member.send(`🎉 **Verification successful!**\n\nI found the code **${matchedCode}** in the bio of **@${record.username}**.\nYou've been given the **Verified Viewer** role in **${guild.name}**.\n\nYou can remove the code from your TikTok bio now. 💀`);
            console.log(`[Background Verify] Sent DM to ${member.user.tag}`);
          } catch (dmErr) {
            console.log(`[Background Verify] Could not DM ${member.user.tag} - DMs may be disabled`);
          }

        } catch (verifyErr) {
          console.error(`[Background Verify] Error verifying ${discordId}:`, verifyErr.message);
        }
      } else {
        console.log(`[Background Verify] ${discordId} (@${record.username}) - No code match. Bio: "${lastBio.substring(0, 40)}..."`);
      }

      // Small delay between checks to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
      
    } catch (err) {
      console.error(`[Background Verify] Error checking ${discordId}:`, err.message);
    }
  }

  console.log('[Background Verify] Check complete.');
}

// Start background verification scheduler
function startBackgroundVerificationScheduler() {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  
  // Run initial check after 2 minutes (give time for bot to fully start)
  setTimeout(async () => {
    await runBackgroundVerificationCheck();
  }, 2 * 60 * 1000);
  
  // Then run every 2 hours
  setInterval(async () => {
    await runBackgroundVerificationCheck();
  }, TWO_HOURS);
  
  console.log('[Background Verify] Scheduler started - will check every 2 hours');
}

// Load pending verifications from file before connecting
loadPendingVerifications();

// When bot is ready
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  
  // Start health check scheduler
  startHealthCheckScheduler();
  
  // Start background verification scheduler
  startBackgroundVerificationScheduler();
});

// Simple text command: !setup-verify
// Helper to send admin response privately via DM and delete command
async function sendAdminResponse(message, content, options = {}) {
  try {
    // Delete the command message to hide it from the channel
    await message.delete().catch(() => {});
    
    // Send response via DM
    if (typeof content === 'string') {
      await message.author.send({ content, ...options });
    } else {
      await message.author.send(content);
    }
  } catch (err) {
    // If DM fails, send ephemeral-like response (auto-delete after 10s)
    try {
      const reply = await message.channel.send(typeof content === 'string' ? content : { ...content });
      setTimeout(() => reply.delete().catch(() => {}), 10000);
    } catch {
      console.error('Could not send admin response:', err);
    }
  }
}

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
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    const testUser = args[0] ? args[0].replace(/^@/, '') : 'tiktok';
    
    // Delete command and send "working" DM
    await message.delete().catch(() => {});
    const dmChannel = await message.author.createDM();
    const statusMsg = await dmChannel.send(`🔍 Testing TikTok bio fetch for **@${testUser}**...`);
    
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
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    const verifyButton = new ButtonBuilder()
      .setCustomId('verify_tiktok_start')
      .setLabel('Verify TikTok')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(verifyButton);

    await message.channel.send({
      content:
        '👋 **TikTok Verification**\n\nVerify your TikTok account to link your identity across platforms.\n\n**Before you start:**\n• Your TikTok profile must be **PUBLIC** (not private)\n• You\'ll receive a code like `JAIME-12345`\n• Add the code to the **BEGINNING** of your TikTok bio\n• Wait 30-60 seconds after saving before verifying\n\nOnce verified, you\'ll receive the **Verified Viewer** role.\n\n💀 Click below to begin:',
      components: [row],
    });

    // Delete command and confirm via DM
    await message.delete().catch(() => {});
    await message.author.send('✅ Verification panel created in #' + message.channel.name).catch(() => {});
  }

  // Command: !verified-list - Show all verified users (admin only)
  if (command.toLowerCase() === 'verified-list') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    // Delete command message
    await message.delete().catch(() => {});

    const verifiedUsers = getVerifiedUsers(message.guild.id);
    
    if (verifiedUsers.length === 0) {
      return message.author.send('📋 No verified users yet.').catch(() => {});
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

    await message.author.send({ embeds: [embed] }).catch(() => {});
  }

  // Command: !verified-export - Export as CSV (admin only)
  if (command.toLowerCase() === 'verified-export') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    // Delete command message
    await message.delete().catch(() => {});

    const verifiedUsers = getVerifiedUsers(message.guild.id);
    
    if (verifiedUsers.length === 0) {
      return message.author.send('📋 No verified users to export.').catch(() => {});
    }

    const csv = 'Discord ID,Discord Tag,TikTok Username,Verified At\n' + 
      verifiedUsers.map(u => 
        `${u.discordId},${u.discordTag},@${u.tiktokUsername},${u.verifiedAt}`
      ).join('\n');

    const buffer = Buffer.from(csv, 'utf8');
    
    await message.author.send({
      content: `📊 Exported ${verifiedUsers.length} verified users:`,
      files: [{
        attachment: buffer,
        name: `verified-users-${message.guild.id}.csv`
      }]
    }).catch(() => {});
  }

  // Command: !manual-verify @user @tiktokUsername - Manually verify a user (admin only)
  if (command.toLowerCase() === 'manual-verify') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    const mentionedUser = message.mentions.users.first();
    const tiktokUsername = args[1]?.replace(/^@/, '') || args[0]?.replace(/^@/, '');

    if (!mentionedUser) {
      return sendAdminResponse(message, 'Usage: `!manual-verify @DiscordUser @tiktokUsername`\n\nExample: `!manual-verify @Bea @penny.the.french.girl`');
    }

    if (!tiktokUsername || tiktokUsername.startsWith('<@')) {
      return sendAdminResponse(message, 'Please provide a TikTok username.\n\nUsage: `!manual-verify @DiscordUser @tiktokUsername`');
    }

    // Delete command message
    await message.delete().catch(() => {});

    try {
      const member = await message.guild.members.fetch(mentionedUser.id);
      const role = message.guild.roles.cache.get(VERIFIED_ROLE_ID);

      if (!role) {
        return message.author.send('❌ Verified role not found. Check VERIFIED_ROLE_ID in your .env').catch(() => {});
      }

      await member.roles.add(role);

      // Save to verified users list
      addVerifiedUser(
        message.guild.id,
        mentionedUser.id,
        mentionedUser.tag,
        tiktokUsername
      );

      await message.author.send(`✅ Manually verified **${mentionedUser.tag}** with TikTok **@${tiktokUsername}**\n\nThey now have the Verified role.`).catch(() => {});
    } catch (err) {
      console.error('Manual verify error:', err);
      await message.author.send(`❌ Error: ${err.message}`).catch(() => {});
    }
  }

  // Command: !pending - Show all pending verifications (admin only)
  if (command.toLowerCase() === 'pending') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    // Delete command message and send via DM
    await message.delete().catch(() => {});
    const dmChannel = await message.author.createDM();
    const statusMsg = await dmChannel.send('🔍 Fetching pending verifications...');

    // Get from in-memory Map and refresh from Redis
    const pendingList = [];
    
    // First, sync from Redis if available
    if (redis) {
      try {
        const keys = await redis.keys('pending:*');
        for (const key of keys) {
          const data = await redis.get(key);
          if (data) {
            const parsed = JSON.parse(data);
            const discordId = key.replace('pending:', '');
            if (!pendingVerifications.has(discordId)) {
              pendingVerifications.set(discordId, parsed);
            }
          }
        }
      } catch (err) {
        console.error('Error fetching from Redis:', err);
      }
    }

    // Build list from in-memory map
    for (const [discordId, record] of pendingVerifications) {
      pendingList.push({
        discordId,
        username: record.username,
        code: record.code,
        previousCodes: record.previousCodes || [],
        createdAt: record.createdAt
      });
    }

    if (pendingList.length === 0) {
      return statusMsg.edit('✅ No pending verifications.');
    }

    // Format output
    let output = `📋 **Pending Verifications:** ${pendingList.length}\n\n`;
    
    for (const p of pendingList.slice(0, 20)) {
      const allCodes = [p.code, ...p.previousCodes].slice(0, 3);
      output += `• <@${p.discordId}> → **@${p.username}** | Codes: ${allCodes.map(c => '`' + c + '`').join(', ')}\n`;
    }

    if (pendingList.length > 20) {
      output += `\n_...and ${pendingList.length - 20} more_`;
    }

    await statusMsg.edit(output);
  }

  // Admin command: cleanup stale pending verifications
  if (command.toLowerCase() === 'cleanup') {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return sendAdminResponse(message, "❌ You don't have permission to use this.");
    }

    // Delete command message and send via DM
    await message.delete().catch(() => {});
    const dmChannel = await message.author.createDM();
    const statusMsg = await dmChannel.send('🧹 Analyzing pending verifications for cleanup...');

    // Sync from Redis first
    if (redis) {
      try {
        const keys = await redis.keys('pending:*');
        for (const key of keys) {
          const data = await redis.get(key);
          if (data) {
            const parsed = JSON.parse(data);
            const discordId = key.replace('pending:', '');
            if (!pendingVerifications.has(discordId)) {
              pendingVerifications.set(discordId, parsed);
            }
          }
        }
      } catch (err) {
        console.error('Error fetching from Redis:', err);
      }
    }

    const toRemove = [];
    const issues = [];
    
    for (const [discordId, record] of pendingVerifications) {
      // Check for records without username (or username is literally "undefined")
      if (!record.username || record.username === 'undefined') {
        toRemove.push({ discordId, reason: 'No username stored' });
        continue;
      }
      
      // Check if TikTok account exists
      const result = await fetchTikTokBio(record.username, 0);
      if (result.accountNotFound) {
        toRemove.push({ discordId, username: record.username, reason: 'TikTok account not found' });
      } else if (result.emptyBio) {
        issues.push({ discordId, username: record.username, issue: 'Empty bio' });
      } else if (!result.bio) {
        issues.push({ discordId, username: record.username, issue: 'Could not fetch' });
      }
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    }

    // Remove stale records
    for (const item of toRemove) {
      pendingVerifications.delete(item.discordId);
      if (redis) {
        await redisDeletePending(item.discordId);
      }
    }
    if (!redis && toRemove.length > 0) {
      savePendingVerifications();
    }

    // Build output
    let output = '🧹 **Cleanup Complete**\n\n';
    
    if (toRemove.length > 0) {
      output += `**Removed ${toRemove.length} stale records:**\n`;
      for (const item of toRemove.slice(0, 10)) {
        output += `• <@${item.discordId}>${item.username ? ` (@${item.username})` : ''} - ${item.reason}\n`;
      }
      if (toRemove.length > 10) {
        output += `_...and ${toRemove.length - 10} more_\n`;
      }
      output += '\n';
    } else {
      output += '✅ No stale records to remove.\n\n';
    }
    
    if (issues.length > 0) {
      output += `**${issues.length} records with issues (kept):**\n`;
      for (const item of issues.slice(0, 10)) {
        output += `• <@${item.discordId}> (@${item.username}) - ${item.issue}\n`;
      }
      if (issues.length > 10) {
        output += `_...and ${issues.length - 10} more_\n`;
      }
    }
    
    output += `\n**Remaining pending:** ${pendingVerifications.size}`;

    await statusMsg.edit(output);
  }

  // ========== BOT OWNER COMMANDS (Premium Management) ==========
  
  // Owner command: Grant free premium to a guild
  if (command.toLowerCase() === 'grant-premium') {
    if (message.author.id !== BOT_OWNER_ID) {
      return; // Silently ignore for non-owners
    }
    
    const guildId = args[0];
    if (!guildId) {
      return sendAdminResponse(message, '❌ Usage: `!grant-premium <guild_id>`\n\nExample: `!grant-premium 123456789012345678`');
    }
    
    if (!SKU_ID) {
      return sendAdminResponse(message, '❌ SKU_ID not configured. Add SKU_ID to your environment variables.');
    }
    
    try {
      // Delete command for privacy
      await message.delete().catch(() => {});
      
      const dmChannel = await message.author.createDM();
      const statusMsg = await dmChannel.send(`⏳ Granting premium to guild ${guildId}...`);
      
      // Create test entitlement via Discord API
      const response = await fetch(`https://discord.com/api/v10/applications/${client.application.id}/entitlements`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sku_id: SKU_ID,
          owner_id: guildId,
          owner_type: 1, // 1 = guild subscription
        }),
      });
      
      if (response.ok) {
        const entitlement = await response.json();
        await statusMsg.edit(`✅ **Premium granted!**\n\n• Guild ID: \`${guildId}\`\n• Entitlement ID: \`${entitlement.id}\`\n• Type: Guild Subscription (Free)\n\n_The guild now has premium access. They may need to reload Discord._`);
      } else {
        const error = await response.json();
        await statusMsg.edit(`❌ **Failed to grant premium**\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``);
      }
    } catch (err) {
      console.error('[Premium] Error granting:', err);
      try {
        const dmChannel = await message.author.createDM();
        await dmChannel.send(`❌ Error granting premium: ${err.message}`);
      } catch {}
    }
  }
  
  // Owner command: Revoke premium from a guild (delete entitlement)
  if (command.toLowerCase() === 'revoke-premium') {
    if (message.author.id !== BOT_OWNER_ID) {
      return; // Silently ignore for non-owners
    }
    
    const entitlementId = args[0];
    if (!entitlementId) {
      return sendAdminResponse(message, '❌ Usage: `!revoke-premium <entitlement_id>`\n\nUse `!premium-list` to find entitlement IDs.');
    }
    
    try {
      // Delete command for privacy
      await message.delete().catch(() => {});
      
      const dmChannel = await message.author.createDM();
      const statusMsg = await dmChannel.send(`⏳ Revoking entitlement ${entitlementId}...`);
      
      // Delete entitlement via Discord API
      const response = await fetch(`https://discord.com/api/v10/applications/${client.application.id}/entitlements/${entitlementId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
        },
      });
      
      if (response.ok || response.status === 204) {
        await statusMsg.edit(`✅ **Premium revoked!**\n\n• Entitlement ID: \`${entitlementId}\`\n\n_The entitlement has been deleted._`);
      } else {
        const error = await response.json().catch(() => ({ message: 'Unknown error' }));
        await statusMsg.edit(`❌ **Failed to revoke premium**\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``);
      }
    } catch (err) {
      console.error('[Premium] Error revoking:', err);
      try {
        const dmChannel = await message.author.createDM();
        await dmChannel.send(`❌ Error revoking premium: ${err.message}`);
      } catch {}
    }
  }
  
  // Owner command: List all entitlements (premium subscriptions)
  if (command.toLowerCase() === 'premium-list') {
    if (message.author.id !== BOT_OWNER_ID) {
      return; // Silently ignore for non-owners
    }
    
    try {
      // Delete command for privacy
      await message.delete().catch(() => {});
      
      const dmChannel = await message.author.createDM();
      const statusMsg = await dmChannel.send('⏳ Fetching entitlements...');
      
      // List entitlements via Discord API
      const response = await fetch(`https://discord.com/api/v10/applications/${client.application.id}/entitlements?limit=100&exclude_ended=true`, {
        method: 'GET',
        headers: {
          'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
        },
      });
      
      if (response.ok) {
        const entitlements = await response.json();
        
        if (entitlements.length === 0) {
          await statusMsg.edit('📋 **No active entitlements found.**\n\nUse `!grant-premium <guild_id>` to grant free premium access.');
          return;
        }
        
        let output = `📋 **Active Entitlements:** ${entitlements.length}\n\n`;
        
        // Group by type
        const guildSubs = entitlements.filter(e => e.guild_id);
        const userSubs = entitlements.filter(e => e.user_id && !e.guild_id);
        
        if (guildSubs.length > 0) {
          output += '**Guild Subscriptions:**\n';
          for (const e of guildSubs.slice(0, 15)) {
            const typeLabel = getEntitlementTypeLabel(e.type);
            const guildName = client.guilds.cache.get(e.guild_id)?.name || 'Unknown';
            output += `• \`${e.id}\` - ${guildName} (\`${e.guild_id}\`) - ${typeLabel}\n`;
          }
          if (guildSubs.length > 15) {
            output += `_...and ${guildSubs.length - 15} more_\n`;
          }
          output += '\n';
        }
        
        if (userSubs.length > 0) {
          output += '**User Subscriptions:**\n';
          for (const e of userSubs.slice(0, 15)) {
            const typeLabel = getEntitlementTypeLabel(e.type);
            output += `• \`${e.id}\` - <@${e.user_id}> - ${typeLabel}\n`;
          }
          if (userSubs.length > 15) {
            output += `_...and ${userSubs.length - 15} more_\n`;
          }
        }
        
        await statusMsg.edit(output);
      } else {
        const error = await response.json();
        await statusMsg.edit(`❌ **Failed to fetch entitlements**\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``);
      }
    } catch (err) {
      console.error('[Premium] Error listing:', err);
      try {
        const dmChannel = await message.author.createDM();
        await dmChannel.send(`❌ Error listing entitlements: ${err.message}`);
      } catch {}
    }
  }
  
  // Owner command: Check if a specific guild has premium
  if (command.toLowerCase() === 'check-premium') {
    if (message.author.id !== BOT_OWNER_ID) {
      return; // Silently ignore for non-owners
    }
    
    const guildId = args[0];
    if (!guildId) {
      return sendAdminResponse(message, '❌ Usage: `!check-premium <guild_id>`');
    }
    
    try {
      // Delete command for privacy
      await message.delete().catch(() => {});
      
      const dmChannel = await message.author.createDM();
      const statusMsg = await dmChannel.send(`⏳ Checking premium status for guild ${guildId}...`);
      
      // Check entitlements for this guild
      const response = await fetch(`https://discord.com/api/v10/applications/${client.application.id}/entitlements?guild_id=${guildId}&exclude_ended=true`, {
        method: 'GET',
        headers: {
          'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
        },
      });
      
      if (response.ok) {
        const entitlements = await response.json();
        const guildName = client.guilds.cache.get(guildId)?.name || 'Unknown';
        
        if (entitlements.length === 0) {
          await statusMsg.edit(`❌ **No premium**\n\n• Guild: ${guildName} (\`${guildId}\`)\n• Status: No active entitlements\n\nUse \`!grant-premium ${guildId}\` to grant free access.`);
        } else {
          let output = `✅ **Has premium!**\n\n• Guild: ${guildName} (\`${guildId}\`)\n• Active entitlements: ${entitlements.length}\n\n`;
          for (const e of entitlements) {
            const typeLabel = getEntitlementTypeLabel(e.type);
            output += `• \`${e.id}\` - ${typeLabel}`;
            if (e.ends_at) output += ` (expires: ${new Date(e.ends_at).toLocaleDateString()})`;
            output += '\n';
          }
          await statusMsg.edit(output);
        }
      } else {
        const error = await response.json();
        await statusMsg.edit(`❌ **Failed to check premium**\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``);
      }
    } catch (err) {
      console.error('[Premium] Error checking:', err);
      try {
        const dmChannel = await message.author.createDM();
        await dmChannel.send(`❌ Error checking premium: ${err.message}`);
      } catch {}
    }
  }
});

// Helper: Get human-readable entitlement type
function getEntitlementTypeLabel(type) {
  const types = {
    1: '💰 Purchased',
    2: '💎 Nitro',
    3: '🎁 Dev Gift',
    4: '🧪 Test Mode',
    5: '🆓 Free',
    6: '🎁 User Gift',
    7: '💎 Nitro Bonus',
    8: '📱 Subscription',
  };
  return types[type] || `Type ${type}`;
}

// Handle interactions (buttons + modals)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button: start verification - generate code first
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_tiktok_start') {
        // Check if user already has an active verification in progress
        if (activeVerifications.has(interaction.user.id)) {
          return interaction.reply({
            content: '⏳ **You already have a verification in progress!**\n\nPlease wait for your current verification to complete (up to 10 minutes).\n\nIf you need to start over, wait for the current check to finish, or ask an admin to manually verify you.',
            ephemeral: true,
          });
        }
        
        // Generate code immediately
        const code = await generateCode(interaction.guild);
        
        // Get existing record to preserve previous codes (check Redis first, then memory)
        let existingRecord = pendingVerifications.get(interaction.user.id);
        if (!existingRecord && redis) {
          existingRecord = await redisGetPending(interaction.user.id);
        }
        const previousCodes = existingRecord?.previousCodes || [];
        
        // Add current code to previous codes (keep last 5)
        if (existingRecord?.code) {
          previousCodes.unshift(existingRecord.code);
          if (previousCodes.length > 5) previousCodes.pop();
        }
        
        // Store the code for this user with previous codes
        const pendingData = {
          code,
          previousCodes,
          guildId: interaction.guild.id,
        };
        pendingVerifications.set(interaction.user.id, pendingData);
        if (redis) {
          await redisSavePending(interaction.user.id, pendingData);
        } else {
          savePendingVerifications();
        }

        // Show code and button to continue
        const continueButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_added')
          .setLabel('I Added the Code - Enter My Profile')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(continueButton);

        await interaction.reply({
          content: `🔐 **Step 1: Add this code to your TikTok bio**\n\nYour unique verification code:\n\`\`\`\n${code}\n\`\`\`\n\n**⚠️ IMPORTANT:**\n• Your TikTok profile must be **PUBLIC** (not private)\n• The code must be at the **BEGINNING** of your bio\n• Copy the code exactly as shown (e.g., \`JAIME-12345\`)\n\n**Instructions:**\n1. Open TikTok and go to your profile\n2. Make sure your account is **public** (Settings → Privacy → Private Account = OFF)\n3. Tap "Edit profile"\n4. Paste the code at the **very beginning** of your bio\n5. Save your profile\n6. Click the button below\n\n⏳ **Verification may take up to 24 hours** due to TikTok's caching. You'll be notified via DM when verified!\n\n🗑️ You can remove the code after verification is complete.`,
          components: [row],
          ephemeral: true,
        });
      }

      // Button: user says they added the code, now ask for profile link
      if (interaction.customId === 'verify_tiktok_added') {
        let record = pendingVerifications.get(interaction.user.id);
        if (!record && redis) {
          record = await redisGetPending(interaction.user.id);
          if (record) pendingVerifications.set(interaction.user.id, record);
        }
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
        let record = pendingVerifications.get(interaction.user.id);
        if (!record && redis) {
          record = await redisGetPending(interaction.user.id);
          if (record) pendingVerifications.set(interaction.user.id, record);
        }
        if (!record) {
          return interaction.reply({
            content:
              'I could not find a pending verification for you. Please start again.',
            ephemeral: true,
          });
        }

        // Check if user already has an active verification check running
        if (activeVerifications.has(interaction.user.id)) {
          return interaction.reply({
            content: '⏳ **Check already in progress!**\n\nPlease wait a moment for the current check to complete.',
            ephemeral: true,
          });
        }

        // Mark user as having an active verification check
        activeVerifications.add(interaction.user.id);

        await interaction.deferReply({ ephemeral: true });

        await interaction.editReply('🔍 **Checking your TikTok bio...**\n\nThis will only take a moment...');

        // Quick check - 3 attempts with short delays (handles immediate cases)
        const maxAttempts = 3;
        const delayBetweenAttempts = 3000; // 3 seconds
        let verified = false;
        let lastBio = null;
        let foundCode = null;
        let accountNotFound = false;
        let emptyBio = false;
        
        try {
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await fetchTikTokBio(record.username, attempt);
            
            // If account not found, stop immediately
            if (result.accountNotFound) {
              accountNotFound = true;
              break;
            }
            
            if (result.emptyBio) {
              emptyBio = true;
            }
            
            if (result.bio) {
              lastBio = result.bio;
              const bioUpper = result.bio.toUpperCase();
              
              // Check current code AND previous codes (handles TikTok CDN lag)
              const allCodes = [record.code, ...(record.previousCodes || [])];
              let matchedCode = null;
              
              for (const code of allCodes) {
                const codeUpper = code.toUpperCase();
                // Also check for common typo: JAMIE instead of JAIME
                const typoVariant = codeUpper.replace('JAIME', 'JAMIE');
                
                if (bioUpper.includes(codeUpper) || bioUpper.includes(typoVariant)) {
                  matchedCode = code;
                  break;
                }
              }
              
              console.log(`[VERIFY] User: ${interaction.user.tag} (${interaction.user.id}) | TikTok: @${record.username} | Quick check ${attempt}/${maxAttempts} - Bio: "${result.bio.substring(0, 50)}..." - Checking codes: ${allCodes.join(', ')} - Matched: ${matchedCode || 'none'}`);
              
              if (matchedCode) {
                verified = true;
                foundCode = matchedCode;
                break;
              }
            } else {
              console.log(`[VERIFY] User: ${interaction.user.tag} (${interaction.user.id}) | TikTok: @${record.username} | Quick check ${attempt}/${maxAttempts} - Could not fetch bio`);
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
          console.log(`[VERIFY] Account not found: ${accountNotFound}`);
          
          // Handle account not found
          if (accountNotFound) {
            console.log(`[VERIFY] FAILED - Account not found`);
            // Remove from pending since the account doesn't exist
            pendingVerifications.delete(interaction.user.id);
            if (redis) {
              await redisDeletePending(interaction.user.id);
            } else {
              savePendingVerifications();
            }
            await interaction.editReply(
              `❌ **TikTok account not found!**\n\nThe username **@${record.username}** doesn't exist on TikTok.\n\n**Please check:**\n• Did you spell your username correctly?\n• Is your account banned or deleted?\n• Try visiting tiktok.com/@${record.username} in your browser\n\nPlease start the verification process again with the correct username.`,
            );
            return;
          }
          
          // Handle empty bio
          if (emptyBio && !lastBio) {
            console.log(`[VERIFY] FAILED - Bio is empty`);
            await interaction.editReply(
              `❌ **Your TikTok bio is empty!**\n\nI found your account **@${record.username}**, but your bio is blank.\n\nPlease add this code to your TikTok bio:\n\`\`\`${record.code}\`\`\`\n\nThen click **"I Added the Code"** again.`,
            );
            return;
          }
          
          if (!lastBio) {
            console.log(`[VERIFY] FAILED - No bio returned`);
            await interaction.editReply(
              '❌ I could not read your TikTok profile.\n\n**Troubleshooting:**\n• Make sure your profile is **public** (not private)\n• Your username might be incorrect\n• Try opening your profile on tiktok.com to confirm it\'s public\n\nOnce fixed, click **"I Added the Code"** again.',
            );
            return;
          }

          if (verified) {
            // Verified immediately!
            pendingVerifications.delete(interaction.user.id);
            if (redis) {
              await redisDeletePending(interaction.user.id);
            } else {
              savePendingVerifications();
            }

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
              `🎉 **Verification successful!**\n\nI found the code **${foundCode}** in the bio of **@${record.username}**.\nYou've been given the **Verified Viewer** role.\n\nYou can remove the code from your TikTok bio now. 💀`,
            );
          } else {
            // Not found immediately - tell user about background checks
            const allCodes = [record.code, ...(record.previousCodes || [])];
            await interaction.editReply(
              `⏳ **Code not found yet - but don't worry!**\n\n**TikTok's servers can take up to 24 hours** to sync bio changes across their network.\n\n**What happens now:**\n• I'll automatically check your bio every 2 hours\n• When I find the code, I'll **DM you** and give you the role\n• You don't need to do anything else!\n\n**Your info:**\n• Profile: **@${record.username}**\n• Looking for: ${allCodes.map(c => '\`' + c + '\`').join(' or ')}\n\n**Make sure:**\n✅ Your profile is **public**\n✅ The code is in your bio\n✅ You saved the changes on TikTok\n\n_If it's been more than 24 hours, ask an admin to use \`!manual-verify\`_`,
            );
          }
        } finally {
          // Always remove from active verifications when done
          activeVerifications.delete(interaction.user.id);
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

        console.log(`[MODAL] New flow - User ${interaction.user.tag} (${interaction.user.id}) submitted: "${linkInput}"`);

        // Check for empty input
        if (!linkInput) {
          return interaction.reply({
            content: '❌ **Please enter your TikTok username or profile link.**\n\nAccepted formats:\n• `@yourname`\n• `yourname`\n• `https://tiktok.com/@yourname`\n• `tiktok.com/@yourname`',
            ephemeral: true,
          });
        }

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

        // Validate username format
        // TikTok usernames: 2-24 characters, letters, numbers, underscores, periods only
        const validUsernameRegex = /^[a-zA-Z0-9_.]{2,24}$/;
        if (!username || username === 'undefined' || !validUsernameRegex.test(username)) {
          return interaction.reply({
            content: `❌ **Invalid TikTok username format.**\n\nYou entered: \`${linkInput}\`\n\n**TikTok usernames must:**\n• Be 2-24 characters long\n• Only contain letters, numbers, underscores (_) or periods (.)\n• No spaces or emojis\n\n**Accepted formats:**\n• \`@yourname\`\n• \`yourname\`\n• \`https://tiktok.com/@yourname\``,
            ephemeral: true,
          });
        }

        let record = pendingVerifications.get(interaction.user.id);
        if (!record && redis) {
          record = await redisGetPending(interaction.user.id);
          if (record) pendingVerifications.set(interaction.user.id, record);
        }
        if (!record) {
          return interaction.reply({
            content: 'I could not find a pending verification for you. Please start again.',
            ephemeral: true,
          });
        }

        // Update record with username
        record.username = username;
        pendingVerifications.set(interaction.user.id, record);
        if (redis) {
          await redisSavePending(interaction.user.id, record);
        } else {
          savePendingVerifications();
        }

        const checkButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_check')
          .setLabel('Verify Now')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(checkButton);

        await interaction.reply({
          content: `📋 **Step 2: Verify your profile**\n\nTikTok username: **@${username}**\nVerification code: \`${record.code}\`\n\nMake sure the code is in your bio, then click **"Verify Now"**.\n\n⏳ **Verification may take up to 24 hours** due to TikTok's caching. If not verified immediately, I'll keep checking and **DM you** when it's done!`,
          components: [row],
          ephemeral: true,
        });
      }

      // Old flow (keeping for backwards compatibility)
      if (interaction.customId === 'verify_tiktok_modal') {
        const rawInput = interaction.fields
          .getTextInputValue('tiktok_username')
          .trim();

        console.log(`[MODAL] Old flow - User ${interaction.user.tag} (${interaction.user.id}) submitted: "${rawInput}"`);

        // Validate input isn't empty
        if (!rawInput) {
          return interaction.reply({
            content: '❌ Please enter your TikTok username or profile link.',
            ephemeral: true,
          });
        }

        // Extract username from URL if provided, otherwise use as-is
        let username = rawInput;
        const urlMatch = rawInput.match(/(?:https?:\/\/)?(?:www\.|vm\.)?tiktok\.com\/@([a-zA-Z0-9_.]+)/i);
        if (urlMatch) {
          username = urlMatch[1];
        } else {
          // Clean up the username
          username = rawInput.replace(/^@/, '').trim();
        }

        // Validate username format
        if (!username || !/^[a-zA-Z0-9_.]{2,24}$/.test(username)) {
          return interaction.reply({
            content: '❌ That doesn\'t look like a valid TikTok username. TikTok usernames:\n• Are 2-24 characters long\n• Can only contain letters, numbers, underscores, and periods\n• No spaces or emojis\n\nPlease try again with just your username (e.g., `yourname` or `@yourname`).',
            ephemeral: true,
          });
        }

        const code = await generateCode(interaction.guild);
        const oldFlowData = {
          username: username,
          code,
          guildId: interaction.guild.id,
        };
        pendingVerifications.set(interaction.user.id, oldFlowData);
        if (redis) {
          await redisSavePending(interaction.user.id, oldFlowData);
        } else {
          savePendingVerifications();
        }

        const checkButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_check')
          .setLabel('I Added the Code')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(checkButton);

        await interaction.reply({
          content: `Great! We're verifying your TikTok.\n\nTikTok username: **@${username}**\n\nPlease temporarily add this code to your TikTok bio:\n\`\`\`\n${code}\n\`\`\`\nOnce it's in your bio, click **"I Added the Code"** below and I'll check it.\n\nIf you change your mind, you can ignore this and nothing will happen.`,
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

// Handle role changes - auto-unverify when Verified role is removed
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    // Check if Verified role was removed
    const hadVerifiedRole = oldMember.roles.cache.has(VERIFIED_ROLE_ID);
    const hasVerifiedRole = newMember.roles.cache.has(VERIFIED_ROLE_ID);
    
    if (hadVerifiedRole && !hasVerifiedRole) {
      // Role was removed - unverify the user
      const removed = removeVerifiedUser(newMember.guild.id, newMember.id);
      if (removed) {
        console.log(`[ROLE] Verified role removed from ${newMember.user.tag} (${newMember.id}) - unverified`);
      }
      
      // Also clear any pending verification
      if (pendingVerifications.has(newMember.id)) {
        pendingVerifications.delete(newMember.id);
        await redisDeletePending(newMember.id);
        console.log(`[ROLE] Cleared pending verification for ${newMember.user.tag}`);
      }
    }
  } catch (err) {
    console.error('[ROLE] Error handling role change:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);
