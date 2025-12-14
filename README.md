# TikTok Verification Bot

A Discord bot that verifies users' TikTok accounts by checking for a unique code in their TikTok bio. Perfect for communities that want to link Discord members to their TikTok profiles.

## Features

- 🔐 **One-click verification** - Users click "Verify TikTok" to start
- 🎯 **Unique codes** - Bot generates server-specific codes (e.g., `JAIME-12345`)
- ✅ **Automatic role assignment** - Verified users get a role automatically
- 📋 **Verified users list** - Admins can view and export all verified users
- 💾 **Persistent storage** - Redis-backed with file fallback for self-hosting
- 🌐 **24/7 hosting ready** - Designed for Railway with Redis addon (or standalone with file storage)
- 🏥 **Health checks** - Automatic checks every 4 hours to ensure TikTok access
- 🔧 **Smart TikTok fetching** - Uses Android mobile headers + cache-busting to bypass CDN
- 🔗 **Flexible input** - Accepts username (`bea.spoke`), handle (`@bea.spoke`), or full URL
- 👮 **Manual verify** - Admins can manually verify users when needed
- ⏳ **Background verification** - Checks pending verifications every 5 minutes automatically
- 🔄 **Previous codes accepted** - Accepts last 5 codes if user regenerates during verification
- 📬 **DM notifications** - Users get a DM when background verification succeeds
- 🚫 **Auto-unverify** - When Verified role is removed, user is removed from verified list
- ✏️ **Typo tolerance** - Accepts common typos like `JAMIE` instead of `JAIME`
- 🔍 **Username variations** - Auto-checks similar usernames when repeated characters cause issues
- 📊 **Verification logs** - Complete audit trail of all verification attempts
- 🎛️ **Slash commands** - Modern Discord slash command interface

## How Verification Works

1. User clicks **"Verify TikTok"** button
2. Bot shows a unique verification code
3. User adds the code to the **beginning** of their TikTok bio
4. User clicks **"I Added the Code"** and enters their TikTok profile link
5. Bot does a **quick check** (3 attempts)
6. If found immediately → User receives the **Verified** role 🎉
7. If not found → Bot tells user it will **keep checking** and DM them when verified
8. Background job runs every **5 minutes**, checking all pending verifications
9. When code is found → User gets the role and receives a DM notification

---

## Slash Commands

### Admin Commands

| Command | Description |
|---------|-------------|
| `/setup-verify` | Creates the verification panel in the current channel |
| `/set-verified-role` | Set the role given to verified users |
| `/verified-list` | Shows all verified users with their TikTok profiles |
| `/verified-export` | Exports verified users as a CSV file |
| `/pending` | Shows all pending verifications from Redis |
| `/test-tiktok [username]` | Tests if the bot can read TikTok bios |
| `/manual-verify` | Manually verify a user without bio check |
| `/unverify` | Remove a user's verification |
| `/verification-log` | View verification history (pending, verified, failed) |
| `/export-log` | Export verification log as CSV file |
| `/backfill-log` | Populate verification log from existing records |
| `/debug` | Show bot debug info (Redis, pending count, health) |

### Accepted TikTok Input Formats

Users can enter their TikTok in any of these formats:

- `username` (e.g., `bea.spoke`)
- `@username` (e.g., `@bea.spoke`)
- Full URL (e.g., `https://www.tiktok.com/@bea.spoke`)
- URL with parameters (e.g., `https://www.tiktok.com/@bea.spoke?is_from_webapp=1`)

### User Flow

1. User clicks the **"Verify TikTok"** button
2. Bot shows their unique verification code (e.g., `JAIME-12345`)
3. User adds the code to the **beginning** of their TikTok bio
4. User clicks **"I Added the Code"**
5. User enters their TikTok profile link in the modal
6. Bot does a quick check (3 attempts over ~10 seconds)
7. **If found immediately:** User receives the **Verified** role 🎉
8. **If not found:** Bot tells user it will check every 5 minutes and DM them when verified
9. Background job runs every 5 minutes, checking all pending verifications
10. When code is found, user receives a DM and gets the Verified role

---

## Setup Instructions

### 1. Discord Developer Portal Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** and give it a name
3. Go to the **Bot** section and click **"Add Bot"**
4. Copy your **Bot Token** (you'll need this for environment variables)

#### Enable Privileged Intents

In the **Bot** section, scroll down to **Privileged Gateway Intents** and enable:

- ✅ **SERVER MEMBERS INTENT**
- ✅ **MESSAGE CONTENT INTENT**

Click **Save Changes**.

#### Get Your Application Info

From the **General Information** tab, copy:

- **Application ID**
- **Public Key**

---

### 2. Invite the Bot to Your Server

Use this URL (replace `YOUR_CLIENT_ID` with your Application ID):

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268698648&scope=bot%20applications.commands
```

Or use the OAuth2 URL Generator:

1. Go to **OAuth2** → **URL Generator**
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Select bot permissions:
   - ✅ Manage Roles
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

---

### 3. Deploy to Railway

1. Create a new Railway project
2. Connect your GitHub repository
3. Add a **Redis** database (+ New → Database → Redis)
4. Set environment variables (see below)
5. Deploy!

---

### 4. Configure Environment Variables

Set these in Railway (or create a `.env` file locally):

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_APPLICATION_ID=your_application_id_here
DISCORD_PUBLIC_KEY=your_public_key_here
REDIS_URL=redis://default:password@host:port (optional - uses file storage if not set)
BOT_OWNER_ID=your_discord_user_id (optional)
SCRAPER_API_KEY=your_scraperapi_key (recommended - bypasses TikTok anti-bot)
PROXY_URL=http://user:pass@proxy.example.com:port (optional - alternative to ScraperAPI)
```

**Redis is optional** - the bot will use local JSON files for storage if `REDIS_URL` is not configured. Redis is recommended for production deployments on platforms like Railway where the filesystem is ephemeral.

**Proxy is optional** - if TikTok is blocking requests, you can configure a rotating proxy service. Recommended providers:
- [Bright Data](https://brightdata.com/) - Residential proxies
- [Oxylabs](https://oxylabs.io/) - Datacenter & residential
- [SmartProxy](https://smartproxy.com/) - Budget-friendly option
- [ScraperAPI](https://www.scraperapi.com/) - Simple API-based proxy

---

### 5. Configure the Bot in Discord

Once the bot is running:

1. Run `/set-verified-role` and select the role to give verified users
2. Run `/setup-verify` in the channel where you want the verification panel
3. Done! Users can now click "Verify TikTok" to start

**Important:** Make sure the bot's role is **higher** than the Verified role in the role hierarchy.

---

## Troubleshooting

### "Used disallowed intents" Error

Make sure you enabled **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT** in the Discord Developer Portal.

### Bot can't assign roles

Ensure the bot's role is **higher** than the Verified Viewer role in Server Settings → Roles.

### "I could not read your TikTok profile"

- The user's TikTok profile must be **public**
- Run `/test-tiktok` to check if the bot can access TikTok
- Check Railway logs for health check results

### TikTok blocking requests

- The bot uses Android mobile headers to bypass blocking
- Health checks run every 4 hours and log results
- Use `/test-tiktok` to manually verify TikTok access

### TikTok CDN caching (bio changes not showing)

- TikTok's CDN can take time to propagate bio changes
- The bot uses cache-busting query parameters to get fresh content
- **Background verification** runs every 5 minutes to catch delayed updates
- Admins can use `/pending` to see all pending verifications
- Admins can use `/manual-verify` to bypass the bio check

### Username typos with repeated characters

- The bot automatically checks username variations (e.g., `marieeee` vs `marieee`)
- If the exact username fails, it suggests similar usernames that exist

### Bot not responding to commands

- Make sure the bot has permission to read messages in the channel
- Slash commands are automatically registered on startup
- Try kicking and re-inviting the bot if commands don't appear

---

## File Structure

```text
jaime-tiktok-bot/
├── index.js                    # Main bot code
├── package.json                # Dependencies
├── server.js                   # Express server for web dashboard
├── index.html                  # Website landing page
├── privacy.html                # Privacy policy
├── terms.html                  # Terms of service
├── vercel.json                 # Vercel deployment config
├── images/                     # Logo and screenshots
└── README.md                   # This file
```

---

## Security Notes

- **Never commit your `.env` file** - it contains sensitive tokens
- The `.gitignore` file is configured to exclude `.env`
- If your bot token is ever exposed, regenerate it immediately in the Discord Developer Portal

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js 18+** | Runtime (native fetch support) |
| **discord.js v14** | Discord bot framework with slash commands |
| **Express.js** | Web server for dashboard |
| **ioredis** | Redis client for persistent storage |
| **Railway** | 24/7 bot hosting with Redis addon |
| **Redis** | Persistent storage for configs, pending, verified users, and logs |

---

## Background Verification System

The bot uses a fast, reliable background verification system:

- **Runs every 5 minutes** - Quick checks, doesn't block
- **Entire cycle completes in seconds** - Checks all pending users rapidly
- **Survives restarts** - Syncs from Redis on every cycle
- **Typo tolerant** - Accepts `JAMIE` instead of `JAIME`
- **Username variations** - Auto-checks similar usernames
- **DM notifications** - Users get notified when verified

---

## License

MIT

