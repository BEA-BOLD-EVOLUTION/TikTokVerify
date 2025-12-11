require('dotenv').config();
const fs = require('fs');
const fsPromises = require('fs').promises;
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
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// VERIFIED_ROLE_ID is now stored per-guild in guild-config.json
const SKU_ID = process.env.SKU_ID; // Your subscription SKU ID (set in Railway, not in code)
const BOT_OWNER_ID = process.env.BOT_OWNER_ID; // Bot owner's Discord user ID (set in Railway, not in code)
const VERIFIED_USERS_FILE = path.join(__dirname, 'verified-users.json');
const PENDING_VERIFICATIONS_FILE = path.join(__dirname, 'pending-verifications.json');
const GUILD_CONFIG_FILE = path.join(__dirname, 'guild-config.json');

// In-memory cache for guild configurations: { guildId: { verifiedRoleId: string } }
const guildConfigs = new Map();

// Premium guilds from environment
// Format: PREMIUM_GUILDS=id:name,id:name  OR just  PREMIUM_GUILDS=id,id
// Example: PREMIUM_GUILDS=1339312549753262140:Jaime,123456789:TestServer
const PREMIUM_GUILDS_RAW = process.env.PREMIUM_GUILDS ? process.env.PREMIUM_GUILDS.split(',').map(entry => entry.trim()) : [];
const PREMIUM_GUILDS = new Map();
for (const entry of PREMIUM_GUILDS_RAW) {
  if (entry.includes(':')) {
    const [id, name] = entry.split(':');
    PREMIUM_GUILDS.set(id.trim(), name.trim());
  } else {
    PREMIUM_GUILDS.set(entry.trim(), 'Unknown');
  }
}

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

// Load guild configurations from file (async)
async function loadGuildConfigs() {
  // Try Redis first if available
  if (redis) {
    try {
      const keys = await redis.keys(`${REDIS_PREFIX}config:*`);
      if (keys.length > 0) {
        for (const key of keys) {
          const guildId = key.replace(`${REDIS_PREFIX}config:`, '');
          const data = await redis.get(key);
          if (data) {
            guildConfigs.set(guildId, JSON.parse(data));
          }
        }
        console.log(`[Config] Loaded configurations for ${guildConfigs.size} guilds from Redis`);
        return;
      }
    } catch (err) {
      console.error('[Redis] Error loading guild configs:', err.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(GUILD_CONFIG_FILE)) {
      const data = await fsPromises.readFile(GUILD_CONFIG_FILE, 'utf8');
      const configs = JSON.parse(data);
      for (const [guildId, config] of Object.entries(configs)) {
        guildConfigs.set(guildId, config);
      }
      console.log(`[Config] Loaded configurations for ${guildConfigs.size} guilds from file`);
    }
  } catch (err) {
    console.error('[Config] Error loading guild configs:', err);
  }
}

// Save guild configurations to file (async)
async function saveGuildConfigs() {
  // Save to Redis if available
  if (redis) {
    try {
      for (const [guildId, config] of guildConfigs.entries()) {
        await redis.set(`${REDIS_PREFIX}config:${guildId}`, JSON.stringify(config));
      }
    } catch (err) {
      console.error('[Redis] Error saving guild configs:', err.message);
    }
  }
  
  // Also save to file as backup
  try {
    const configs = Object.fromEntries(guildConfigs);
    await fsPromises.writeFile(GUILD_CONFIG_FILE, JSON.stringify(configs, null, 2));
  } catch (err) {
    console.error('[Config] Error saving guild configs:', err);
  }
}

// Get verified role ID for a guild
function getVerifiedRoleId(guildId) {
  const config = guildConfigs.get(guildId);
  return config?.verifiedRoleId || null;
}

// Set verified role ID for a guild
async function setVerifiedRoleId(guildId, roleId) {
  const config = guildConfigs.get(guildId) || {};
  config.verifiedRoleId = roleId;
  guildConfigs.set(guildId, config);
  await saveGuildConfigs();
}

// Track users currently in active verification polling (to prevent multiple loops)
const activeVerifications = new Set();

// Cache for server prefixes: { guildId: prefix }
const serverPrefixes = new Map();

// Cache for guild entitlements: { guildId: { hasAccess: boolean, checkedAt: timestamp } }
const entitlementCache = new Map();
const ENTITLEMENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Check if a guild has an active subscription/entitlement
async function checkGuildEntitlement(guildId) {
  // If SKU_ID is not configured, skip subscription checks (self-hosted mode)
  if (!SKU_ID) {
    return true;
  }
  
  // Check if guild is in PREMIUM_GUILDS environment variable
  if (PREMIUM_GUILDS.has(guildId)) {
    const guildLabel = PREMIUM_GUILDS.get(guildId);
    console.log(`[Entitlement] Guild ${guildId} (${guildLabel}) has env-based premium access`);
    return true;
  }
  
  // Check cache first
  const cached = entitlementCache.get(guildId);
  if (cached && Date.now() - cached.checkedAt < ENTITLEMENT_CACHE_TTL) {
    return cached.hasAccess;
  }
  
  // Check Redis for manually granted premium
  if (redis) {
    try {
      const manualGrant = await redis.get(`${REDIS_PREFIX}premium:${guildId}`);
      if (manualGrant) {
        console.log(`[Entitlement] Guild ${guildId} has Redis-based premium access`);
        entitlementCache.set(guildId, { hasAccess: true, checkedAt: Date.now() });
        return true;
      }
    } catch (err) {
      console.error('[Entitlement] Redis check error:', err.message);
    }
  }
  
  try {
    const response = await fetch(
      `https://discord.com/api/v10/applications/${client.application.id}/entitlements?guild_id=${guildId}&sku_ids=${SKU_ID}&exclude_ended=true`,
      {
        headers: {
          'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
        },
      }
    );
    
    if (response.ok) {
      const entitlements = await response.json();
      const hasAccess = entitlements.length > 0;
      
      // Cache the result
      entitlementCache.set(guildId, { hasAccess, checkedAt: Date.now() });
      
      return hasAccess;
    } else {
      console.error('[Entitlement] API error:', response.status);
      // On API error, check cache even if expired, or default to false
      return cached?.hasAccess || false;
    }
  } catch (err) {
    console.error('[Entitlement] Check error:', err.message);
    return cached?.hasAccess || false;
  }
}


// Get the subscription message for non-subscribers
function getSubscriptionMessage() {
  return {
    content: '🔒 **Subscription Required**\n\n' +
      'This bot requires an active subscription to use.\n\n' +
      '**Options:**\n' +
      '• Subscribe for **$4.99/month** in the Discord App Library\n' +
      '• Join the **Bold Evolution Agency** for free access\n\n' +
      '👉 [Get the Bot](https://discord.com/discovery/applications/1446313791108419594)',
    ephemeral: true,
  };
}

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
      const data = await fsPromises.readFile(PENDING_VERIFICATIONS_FILE, 'utf8');
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

// Save pending verifications (to Redis and file) - async
async function savePendingVerifications() {
  // Save to Redis if available
  if (redis) {
    // Redis saves are done individually in set/delete operations
    return;
  }
  
  // Fallback: save to file (async)
  try {
    const obj = Object.fromEntries(pendingVerifications);
    await fsPromises.writeFile(PENDING_VERIFICATIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Error saving pending verifications to file:', err);
  }
}

// Get all pending verifications as a Map (combines Redis and in-memory)
async function getAllPendingVerifications() {
  const result = new Map();
  
  // First, get from Redis if available
  if (redis) {
    const redisData = await redisGetAllPending();
    for (const [userId, data] of Object.entries(redisData)) {
      result.set(userId, data);
    }
  }
  
  // Also check in-memory cache
  for (const [userId, data] of pendingVerifications.entries()) {
    if (!result.has(userId)) {
      result.set(userId, data);
    }
  }
  
  return result;
}

// Remove a pending verification
async function removePendingVerification(discordId) {
  pendingVerifications.delete(discordId);
  if (redis) {
    await redisDeletePending(discordId);
  } else {
    savePendingVerifications();
  }
}

// Load verified users from file (async)
async function loadVerifiedUsers() {
  // Try Redis first if available
  if (redis) {
    try {
      const keys = await redis.keys(`${REDIS_PREFIX}verified:*`);
      if (keys.length > 0) {
        const users = {};
        for (const key of keys) {
          const guildId = key.replace(`${REDIS_PREFIX}verified:`, '');
          const data = await redis.get(key);
          if (data) {
            users[guildId] = JSON.parse(data);
          }
        }
        return users;
      }
    } catch (err) {
      console.error('[Redis] Error loading verified users:', err.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(VERIFIED_USERS_FILE)) {
      const data = await fsPromises.readFile(VERIFIED_USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading verified users:', err);
  }
  return {};
}

// Save verified users to file (async)
async function saveVerifiedUsers(users) {
  // Save to Redis if available
  if (redis) {
    try {
      for (const [guildId, guildUsers] of Object.entries(users)) {
        await redis.set(`${REDIS_PREFIX}verified:${guildId}`, JSON.stringify(guildUsers));
      }
    } catch (err) {
      console.error('[Redis] Error saving verified users:', err.message);
    }
  }
  
  // Also save to file as backup
  try {
    await fsPromises.writeFile(VERIFIED_USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving verified users:', err);
  }
}

// Add a verified user (async)
async function addVerifiedUser(guildId, discordId, discordTag, tiktokUsername) {
  const users = await loadVerifiedUsers();
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
  
  await saveVerifiedUsers(users);
}

// Remove a verified user (async)
async function removeVerifiedUser(guildId, discordId) {
  const users = await loadVerifiedUsers();
  if (!users[guildId]) return false;
  
  const index = users[guildId].findIndex(u => u.discordId === discordId);
  if (index >= 0) {
    const removed = users[guildId].splice(index, 1)[0];
    await saveVerifiedUsers(users);
    console.log(`[UNVERIFY] Removed ${removed.discordTag} (${discordId}) | TikTok: @${removed.tiktokUsername} | Guild: ${guildId}`);
    return true;
  }
  return false;
}

// Get verified users for a guild (async)
async function getVerifiedUsers(guildId) {
  const users = await loadVerifiedUsers();
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
    // Add timeout using AbortController (10 second timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const res = await fetch(url, { 
      headers,
      signal: controller.signal 
    });
    clearTimeout(timeout);

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
// This does 10 quick attempts with 5 second delays. Background checker handles long-term checks every 2 hours.
async function fetchTikTokBioWithRetry(username, maxRetries = 10) {
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
    
    // 5 second delay between retries
    if (i < maxRetries - 1) {
      console.log(`Waiting 5s before retry ${i + 2}...`);
      await new Promise(r => setTimeout(r, 5000));
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
      // Try up to 120 times total (12 rounds of 10 attempts with 5 second delays)
      let result = null;
      let lastBio = null;
      const maxRounds = 12;
      const attemptsPerRound = 10;
      let verified = false;
      
      for (let round = 1; round <= maxRounds && !verified; round++) {
        console.log(`[Background Verify] ${discordId} (@${record.username}) - Round ${round}/${maxRounds}`);
        
        for (let attempt = 1; attempt <= attemptsPerRound && !verified; attempt++) {
          result = await fetchTikTokBio(record.username, (round - 1) * attemptsPerRound + attempt - 1);
          
          if (result.accountNotFound) {
            console.log(`[Background Verify] ${discordId} (@${record.username}) - Account not found, removing from pending`);
            pendingVerifications.delete(discordId);
            if (redis) {
              await redisDeletePending(discordId);
            }
            break;
          }
          
          if (result.bio) {
            lastBio = result.bio;
            
            // Check if code is in bio
            const bioUpper = result.bio.toUpperCase();
            const allCodes = [record.code, ...(record.previousCodes || [])];
            
            for (const code of allCodes) {
              const codeUpper = code.toUpperCase();
              const typoVariant = codeUpper.replace('JAIME', 'JAMIE');
              
              if (bioUpper.includes(codeUpper) || bioUpper.includes(typoVariant)) {
                // Found it! Stop all attempts
                console.log(`[Background Verify] ✅ Found code on round ${round}, attempt ${attempt}`);
                verified = true;
                break;
              }
            }
          }
          
          // Wait 5 seconds before next retry
          if (!verified && attempt < attemptsPerRound) {
            await new Promise(r => setTimeout(r, 5000));
          }
        }
        
        if (result.accountNotFound) {
          break; // Stop all rounds if account not found
        }
        
        // Wait between rounds if not verified yet (optional, can add longer delay here)
        if (!verified && round < maxRounds) {
          console.log(`[Background Verify] ${discordId} - Completed round ${round}, waiting before next round...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      
      if (result.accountNotFound) {
        continue; // Already handled above
      }
      
      if (!lastBio) {
        console.log(`[Background Verify] ${discordId} (@${record.username}) - Could not fetch bio after ${maxRounds * attemptsPerRound} attempts${result.emptyBio ? ' (bio is empty)' : ''}`);
        continue;
      }
      
      if (!verified) {
        console.log(`[Background Verify] ${discordId} (@${record.username}) - Code not found after ${maxRounds * attemptsPerRound} attempts`);
        continue;
      }

      // If we get here, verified is true - find the matched code
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

          const roleId = getVerifiedRoleId(record.guildId);
          if (!roleId) {
            console.log(`[Background Verify] No verified role configured for guild ${record.guildId}`);
            continue;
          }
          
          const role = guild.roles.cache.get(roleId);
          if (!role) {
            console.log(`[Background Verify] Could not find verified role ${roleId}`);
            continue;
          }

          await member.roles.add(role);

          // Save to verified users list
          await addVerifiedUser(record.guildId, discordId, member.user.tag, record.username);

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

// Slash command definitions
const slashCommands = [
  new SlashCommandBuilder()
    .setName('setup-verify')
    .setDescription('Create the TikTok verification panel in this channel'),
  new SlashCommandBuilder()
    .setName('set-verified-role')
    .setDescription('Set the role given to verified users')
    .addRoleOption(option => option.setName('role').setDescription('Role to give verified users').setRequired(true)),
  new SlashCommandBuilder()
    .setName('verified-list')
    .setDescription('Show all verified users in this server'),
  new SlashCommandBuilder()
    .setName('verified-export')
    .setDescription('Export verified users as CSV'),
  new SlashCommandBuilder()
    .setName('manual-verify')
    .setDescription('Manually verify a user')
    .addUserOption(option => option.setName('user').setDescription('Discord user to verify').setRequired(true))
    .addStringOption(option => option.setName('tiktok').setDescription('TikTok username').setRequired(true)),
  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Show all pending verifications'),
  new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Remove stale pending verifications'),
  new SlashCommandBuilder()
    .setName('check-tiktok')
    .setDescription('Check if a TikTok account exists')
    .addStringOption(option => option.setName('username').setDescription('TikTok username').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unverify')
    .setDescription('Remove verification from a user')
    .addUserOption(option => option.setName('user').setDescription('User to unverify').setRequired(true)),
  new SlashCommandBuilder()
    .setName('test-tiktok')
    .setDescription('Test if bot can read TikTok bios')
    .addStringOption(option => option.setName('username').setDescription('TikTok username to test').setRequired(false)),
  new SlashCommandBuilder()
    .setName('premium-list')
    .setDescription('List all guilds with premium access (owner only)'),
  new SlashCommandBuilder()
    .setName('check-premium')
    .setDescription('Check premium status of a guild (owner only)')
    .addStringOption(option => option.setName('guild_id').setDescription('Guild ID (defaults to current)').setRequired(false)),
];

// When bot is ready
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`[Config] Bot Owner ID: ${BOT_OWNER_ID || 'NOT SET'}`);
  
  // Load guild configurations
  await loadGuildConfigs();
  
  // Load pending verifications
  await loadPendingVerifications();
  
  // Log premium guilds with names
  if (PREMIUM_GUILDS.size > 0) {
    console.log(`[Config] Premium Guilds (${PREMIUM_GUILDS.size}):`);
    for (const [guildId, name] of PREMIUM_GUILDS.entries()) {
      console.log(`  - ${name}: ${guildId}`);
    }
  } else {
    console.log('[Config] Premium Guilds: None');
  }
  
  // Register slash commands (per-guild only to avoid duplicates)
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commandsJson = slashCommands.map(cmd => cmd.toJSON());
    
    // Clear global commands to remove duplicates
    console.log('[Slash] Clearing global commands...');
    await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
    
    // Register to each guild for instant availability
    console.log(`[Slash] Registering to ${c.guilds.cache.size} guilds...`);
    for (const guild of c.guilds.cache.values()) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(c.user.id, guild.id),
          { body: commandsJson }
        );
        console.log(`[Slash] Registered to guild: ${guild.name}`);
      } catch (guildErr) {
        console.error(`[Slash] Failed to register to ${guild.name}:`, guildErr.message);
      }
    }
    
    console.log('[Slash] All commands registered successfully');
  } catch (err) {
    console.error('[Slash] Error registering commands:', err);
  }
  
  // Start health check scheduler
  startHealthCheckScheduler();
  
  // Start background verification scheduler
  startBackgroundVerificationScheduler();
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

// Handle interactions (buttons + modals + slash commands)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Handle Slash Commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      
      // Admin commands require Administrator permission OR Mods/Admins role
      const hasAdminPerm = interaction.member?.permissions.has(PermissionsBitField.Flags.Administrator);
      const hasModRole = interaction.member?.roles.cache.some(role => 
        role.name.toLowerCase() === 'mods' || role.name.toLowerCase() === 'admins'
      );
      const isAdmin = hasAdminPerm || hasModRole;
      const isOwner = interaction.user.id === BOT_OWNER_ID;
      
      // /setup-verify - Create verification panel
      if (commandName === 'setup-verify') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const hasAccess = await checkGuildEntitlement(interaction.guild.id);
        if (!hasAccess) {
          return interaction.reply({ ...getSubscriptionMessage(), ephemeral: true });
        }
        
        // Check if verified role is configured
        const roleId = getVerifiedRoleId(interaction.guild.id);
        if (!roleId) {
          return interaction.reply({ 
            content: "❌ Please set a verified role first using `/set-verified-role`.", 
            ephemeral: true 
          });
        }
        
        const verifyButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_start')
          .setLabel('Verify TikTok')
          .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(verifyButton);
        
        await interaction.channel.send({
          content: '👋 **TikTok Verification**\n\nVerify your TikTok account to link your identity across platforms.\n\n**Before you start:**\n• Your TikTok profile must be **PUBLIC** (not private)\n• You\'ll receive a verification code\n• Add the code to the **BEGINNING** of your TikTok bio\n• Wait 30-60 seconds after saving before verifying\n\nOnce verified, you\'ll receive the **Verified** role.\n\n💀 Click below to begin:',
          components: [row],
        });
        
        return interaction.reply({ content: '✅ Verification panel created!', ephemeral: true });
      }
      
      // /set-verified-role - Set the verified role
      if (commandName === 'set-verified-role') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const role = interaction.options.getRole('role');
        await setVerifiedRoleId(interaction.guild.id, role.id);
        
        return interaction.reply({ 
          content: `✅ Verified role set to ${role}. Users who complete verification will receive this role.`, 
          ephemeral: true 
        });
      }
      
      // /verified-list - Show verified users
      if (commandName === 'verified-list') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const verifiedUsers = await getVerifiedUsers(interaction.guild.id);
        if (verifiedUsers.length === 0) {
          return interaction.reply({ content: '📋 No verified users yet.', ephemeral: true });
        }
        
        const embed = new EmbedBuilder()
          .setTitle('✅ Verified Users')
          .setColor(0x43b581)
          .setDescription(`Total: **${verifiedUsers.length}** verified users`)
          .setTimestamp();
        
        const usersToShow = verifiedUsers.slice(0, 25);
        const userList = usersToShow.map((u, i) => 
          `**${i + 1}.** <@${u.discordId}> → [@${u.tiktokUsername}](https://tiktok.com/@${u.tiktokUsername})`
        ).join('\n');
        embed.addFields({ name: 'Linked Accounts', value: userList || 'None' });
        
        if (verifiedUsers.length > 25) {
          embed.setFooter({ text: `Showing 25 of ${verifiedUsers.length} users` });
        }
        
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      
      // /verified-export - Export as CSV
      if (commandName === 'verified-export') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        try {
          const verifiedUsers = await getVerifiedUsers(interaction.guild.id);
          if (verifiedUsers.length === 0) {
            return interaction.reply({ content: '📋 No verified users to export.', ephemeral: true });
          }
          
          const csv = 'Discord ID,Discord Tag,TikTok Username,Verified At\n' + 
            verifiedUsers.map(u => `${u.discordId},${u.discordTag},@${u.tiktokUsername},${u.verifiedAt}`).join('\n');
          const buffer = Buffer.from(csv, 'utf8');
          
          return interaction.reply({
            content: `📊 Exported ${verifiedUsers.length} verified users:`,
            files: [{ attachment: buffer, name: `verified-users-${interaction.guild.id}.csv` }],
            ephemeral: true
          });
        } catch (err) {
          console.error('[verified-export] Error:', err);
          return interaction.reply({ content: `❌ Error exporting users: ${err.message}`, ephemeral: true });
        }
      }
      
      // /manual-verify - Manually verify a user
      if (commandName === 'manual-verify') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const targetUser = interaction.options.getUser('user');
        const tiktokUsername = interaction.options.getString('tiktok').replace(/^@/, '');
        
        try {
          const member = await interaction.guild.members.fetch(targetUser.id);
          
          const roleId = getVerifiedRoleId(interaction.guild.id);
          if (roleId) {
            const role = interaction.guild.roles.cache.get(roleId);
            if (role) await member.roles.add(role);
          }
          
          await addVerifiedUser(interaction.guild.id, targetUser.id, targetUser.tag, tiktokUsername);
          return interaction.reply({ content: `✅ Manually verified **${targetUser.tag}** as **@${tiktokUsername}**`, ephemeral: true });
        } catch (err) {
          return interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
        }
      }
      
      // /pending - Show pending verifications
      if (commandName === 'pending') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        
        const allPending = await getAllPendingVerifications();
        const guildPending = [];
        for (const [discordId, data] of allPending.entries()) {
          if (data.guildId === interaction.guild.id) {
            guildPending.push({ discordId, ...data });
          }
        }
        
        if (guildPending.length === 0) {
          return interaction.editReply('📋 No pending verifications in this server.');
        }
        
        const embed = new EmbedBuilder()
          .setTitle('⏳ Pending Verifications')
          .setColor(0xf1c40f)
          .setDescription(`Total: **${guildPending.length}** pending in this server`)
          .setTimestamp();
        
        const pendingList = guildPending.slice(0, 25).map((p, i) => {
          const username = p.username || 'Unknown';
          const code = p.code || 'N/A';
          let timeInfo = '';
          if (p.createdAt) {
            const elapsed = Date.now() - p.createdAt;
            const remaining = Math.max(0, 24 * 60 * 60 * 1000 - elapsed);
            const hoursLeft = Math.floor(remaining / (60 * 60 * 1000));
            const minsLeft = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
            timeInfo = ` (${hoursLeft}h ${minsLeft}m left)`;
          }
          return `**${i + 1}.** <@${p.discordId}> → @${username}\n   Code: \`${code}\`${timeInfo}`;
        }).join('\n\n');
        
        embed.addFields({ name: 'Waiting for Verification', value: pendingList || 'None' });
        if (guildPending.length > 25) embed.setFooter({ text: `Showing 25 of ${guildPending.length} pending` });
        
        return interaction.editReply({ embeds: [embed] });
      }
      
      // /cleanup - Remove stale pending verifications
      if (commandName === 'cleanup') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        
        const allPending = await getAllPendingVerifications();
        let cleaned = 0, checked = 0;
        const issues = [];
        
        for (const [discordId, data] of allPending.entries()) {
          if (data.guildId !== interaction.guild.id) continue;
          checked++;
          let shouldRemove = false, reason = '';
          
          if (!data.username) { shouldRemove = true; reason = 'Missing TikTok username'; }
          if (!data.code) { shouldRemove = true; reason = 'Missing verification code'; }
          if (data.createdAt && Date.now() - data.createdAt > 24 * 60 * 60 * 1000) { shouldRemove = true; reason = 'Expired (>24 hours)'; }
          
          if (!shouldRemove && data.username) {
            const bio = await fetchTikTokBio(data.username, 0);
            if (bio === null) { shouldRemove = true; reason = 'TikTok account not found or private'; }
          }
          
          if (shouldRemove) {
            await removePendingVerification(discordId);
            cleaned++;
            issues.push(`<@${discordId}> (@${data.username || 'unknown'}): ${reason}`);
          }
          await new Promise(r => setTimeout(r, 500));
        }
        
        if (cleaned === 0) {
          return interaction.editReply(`✅ Scanned ${checked} pending verifications. All are valid!`);
        }
        
        const embed = new EmbedBuilder()
          .setTitle('🧹 Cleanup Complete')
          .setColor(0x43b581)
          .setDescription(`Removed **${cleaned}** of **${checked}** pending verifications.`)
          .addFields({ name: 'Removed Entries', value: issues.slice(0, 10).join('\n') || 'None' })
          .setTimestamp();
        if (issues.length > 10) embed.setFooter({ text: `And ${issues.length - 10} more...` });
        
        return interaction.editReply({ embeds: [embed] });
      }
      
      // /check-tiktok - Check TikTok account
      if (commandName === 'check-tiktok') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const username = interaction.options.getString('username').replace(/^@/, '');
        await interaction.deferReply({ ephemeral: true });
        
        const bio = await fetchTikTokBio(username, 0);
        
        if (bio) {
          const embed = new EmbedBuilder()
            .setTitle(`✅ @${username}`)
            .setColor(0x43b581)
            .setDescription('**Account exists and is public**')
            .addFields({ name: '📝 Bio', value: bio.substring(0, 1024) || '*No bio set*' })
            .setURL(`https://tiktok.com/@${username}`)
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        } else {
          return interaction.editReply(`❌ Could not find **@${username}**\n\nPossible reasons:\n• Account doesn't exist\n• Account is private\n• TikTok is blocking requests`);
        }
      }
      
      // /unverify - Remove verification from user
      if (commandName === 'unverify') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const targetUser = interaction.options.getUser('user');
        const verifiedUsers = await getVerifiedUsers(interaction.guild.id);
        const userData = verifiedUsers.find(u => u.discordId === targetUser.id);
        
        if (!userData) {
          return interaction.reply({ content: `❌ **${targetUser.tag}** is not verified.`, ephemeral: true });
        }
        
        await removeVerifiedUser(interaction.guild.id, targetUser.id);
        
        try {
          const member = await interaction.guild.members.fetch(targetUser.id);
          const roleId = getVerifiedRoleId(interaction.guild.id);
          const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
          if (role && member.roles.cache.has(role.id)) await member.roles.remove(role);
        } catch {}
        
        return interaction.reply({ content: `✅ Removed verification for **${targetUser.tag}** (was @${userData.tiktokUsername})`, ephemeral: true });
      }
      
      // /test-tiktok - Test TikTok bio fetching
      if (commandName === 'test-tiktok') {
        if (!isAdmin) {
          return interaction.reply({ content: "❌ You need Administrator permission or Mods/Admins role.", ephemeral: true });
        }
        
        const testUser = interaction.options.getString('username')?.replace(/^@/, '') || 'tiktok';
        await interaction.deferReply({ ephemeral: true });
        
        const bio = await fetchTikTokBio(testUser, 0);
        
        if (bio) {
          return interaction.editReply(`✅ **Success!** Can read TikTok bios.\n\n**@${testUser}'s bio:**\n> ${bio.substring(0, 200)}${bio.length > 200 ? '...' : ''}`);
        } else {
          return interaction.editReply(`❌ **Failed!** Cannot read TikTok bio for @${testUser}.\n\nPossible issues:\n• TikTok may be blocking requests\n• The profile may be private\n• The username may not exist`);
        }
      }
      
      // OWNER ONLY COMMANDS
      
      // /premium-list - List premium guilds
      if (commandName === 'premium-list') {
        if (!isOwner) return interaction.reply({ content: "❌ Owner only command.", ephemeral: true });
        
        const premiumGuilds = [];
        
        if (redis) {
          const keys = await redis.keys(`${REDIS_PREFIX}premium:*`);
          for (const key of keys) {
            const guildId = key.replace(`${REDIS_PREFIX}premium:`, '');
            const data = await redis.get(key);
            const parsed = JSON.parse(data);
            const guild = client.guilds.cache.get(guildId);
            premiumGuilds.push({ guildId, name: guild?.name || 'Unknown', type: '🎁 Manual', grantedAt: parsed.grantedAt });
          }
        }
        
        for (const [guildId, data] of entitlementCache.entries()) {
          if (data.hasAccess && !premiumGuilds.find(g => g.guildId === guildId)) {
            const guild = client.guilds.cache.get(guildId);
            premiumGuilds.push({ guildId, name: guild?.name || 'Unknown', type: data.permanent ? '🎁 Manual' : '💳 Sub' });
          }
        }
        
        if (premiumGuilds.length === 0) {
          return interaction.reply({ content: '📋 No premium guilds.', ephemeral: true });
        }
        
        const embed = new EmbedBuilder()
          .setTitle('💎 Premium Guilds')
          .setColor(0x9b59b6)
          .setDescription(`Total: **${premiumGuilds.length}** guilds`)
          .setTimestamp();
        
        const list = premiumGuilds.slice(0, 25).map((g, i) => `**${i + 1}.** ${g.name}\n   \`${g.guildId}\` ${g.type}`).join('\n\n');
        embed.addFields({ name: 'Guilds', value: list || 'None' });
        
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      
      // /check-premium - Check guild premium status
      if (commandName === 'check-premium') {
        if (!isOwner) return interaction.reply({ content: "❌ Owner only command.", ephemeral: true });
        
        const guildId = interaction.options.getString('guild_id') || interaction.guild.id;
        const guild = client.guilds.cache.get(guildId);
        const cached = entitlementCache.get(guildId);
        
        let manualGrant = null;
        if (redis) {
          const data = await redis.get(`${REDIS_PREFIX}premium:${guildId}`);
          if (data) manualGrant = JSON.parse(data);
        }
        
        const hasAccess = cached?.hasAccess || manualGrant;
        
        const embed = new EmbedBuilder()
          .setTitle(`💎 ${guild?.name || 'Unknown'}`)
          .setColor(hasAccess ? 0x43b581 : 0xe74c3c)
          .setDescription(`\`${guildId}\`\n\n${hasAccess ? '✅ **Premium Active**' : '❌ **No Premium**'}`)
          .setTimestamp();
        
        if (manualGrant) {
          embed.addFields({ name: '🎁 Manual Grant', value: `By: <@${manualGrant.grantedBy}>\nAt: ${manualGrant.grantedAt}` });
        }
        
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      
      return; // End slash command handling
    }
    
    // Button: start verification - generate code first
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_tiktok_start') {
        // Check subscription/entitlement first
        const hasAccess = await checkGuildEntitlement(interaction.guild.id);
        if (!hasAccess) {
          return interaction.reply(getSubscriptionMessage());
        }
        
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
        
        // Store the code temporarily in memory ONLY (not in pending/Redis yet - wait for username)
        const tempData = {
          code,
          previousCodes,
          guildId: interaction.guild.id,
        };
        // Use a temporary in-memory map until they enter username
        if (!global.tempVerificationCodes) global.tempVerificationCodes = new Map();
        global.tempVerificationCodes.set(interaction.user.id, tempData);

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
              await savePendingVerifications();
            }

            const member = await interaction.guild.members.fetch(
              interaction.user.id,
            );
            const roleId = getVerifiedRoleId(interaction.guild.id);
            const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;

            if (!role) {
              await interaction.editReply(
                'I verified your TikTok, but the Verified role is not configured. Please ask an admin to use `/set-verified-role`.',
              );
              return;
            }

            await member.roles.add(role);

            // Save to verified users list
            await addVerifiedUser(
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

        // Get the temp code that was generated in step 1
        if (!global.tempVerificationCodes) global.tempVerificationCodes = new Map();
        const tempData = global.tempVerificationCodes.get(interaction.user.id);
        
        if (!tempData) {
          return interaction.reply({
            content: 'I could not find a verification code for you. Please click "Verify TikTok" to start again.',
            ephemeral: true,
          });
        }
        
        // NOW we save to pending with the username included
        const pendingData = {
          username: username,
          code: tempData.code,
          previousCodes: tempData.previousCodes || [],
          guildId: tempData.guildId,
        };
        
        pendingVerifications.set(interaction.user.id, pendingData);
        if (redis) {
          await redisSavePending(interaction.user.id, pendingData);
        } else {
          savePendingVerifications();
        }
        
        // Clear temp data
        global.tempVerificationCodes.delete(interaction.user.id);

        const checkButton = new ButtonBuilder()
          .setCustomId('verify_tiktok_check')
          .setLabel('Verify Now')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(checkButton);

        await interaction.reply({
          content: `📋 **Step 2: Verify your profile**\n\nTikTok username: **@${username}**\nVerification code: \`${pendingData.code}\`\n\nMake sure the code is in your bio, then click **"Verify Now"**.\n\n⏳ **Verification may take up to 24 hours** due to TikTok's caching. If not verified immediately, I'll keep checking and **DM you** when it's done!`,
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
