# TikTok Verification Bot

A Discord bot that verifies users' TikTok accounts by checking for a unique code in their TikTok bio. Perfect for communities that want to link Discord members to their TikTok profiles.

## Features

- 🔐 **One-click verification** - Users click "Verify TikTok" to start
- 🎯 **Unique codes** - Bot generates server-specific codes (e.g., `JAIME-12345`)
- ✅ **Automatic role assignment** - Verified users get a role automatically
- 📋 **Verified users list** - Admins can view and export all verified users
- 💾 **Persistent storage** - Verified users AND pending verifications survive restarts
- 🌐 **24/7 hosting ready** - Designed for Railway, Heroku, or any Node.js host
- 🏥 **Health checks** - Automatic checks every 4 hours to ensure TikTok access
- 🔧 **Smart TikTok fetching** - Uses Android mobile headers to bypass blocking
- 🔗 **Flexible input** - Accepts username (`bea.spoke`), handle (`@bea.spoke`), or full URL
- 👮 **Manual verify** - Admins can manually verify users when needed
- ⏳ **Extended polling** - Checks TikTok bio for up to 10 minutes (TikTok CDN can be slow)
- 🔄 **Previous codes accepted** - Accepts last 5 codes if user regenerates during verification

## How Verification Works

1. User clicks **"Verify TikTok"** button
2. Bot shows a unique verification code
3. User adds the code to the **beginning** of their TikTok bio
4. User clicks **"I Added the Code"** and enters their TikTok profile link
5. Bot checks their bio for the code
6. If found, user receives the **Verified** role and is saved to the database

---

## Setup Instructions

### 1. Discord Developer Portal Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** and give it a name
3. Go to the **Bot** section and click **"Add Bot"**
4. Copy your **Bot Token** (you'll need this for `.env`)

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

### 3. Create the Verified Role

1. In your Discord server, go to **Server Settings** → **Roles**
2. Create a new role called **"Verified Viewer"** (or any name you prefer)
3. Right-click the role and select **"Copy Role ID"**
   - (You need Developer Mode enabled: User Settings → App Settings → Advanced → Developer Mode)
4. Save this Role ID for the `.env` file

**Important:** Make sure the bot's role is **higher** than the "Verified Viewer" role in the role hierarchy, otherwise it won't be able to assign the role.

---

### 4. Configure Environment Variables

Create a `.env` file in the `jaime-tiktok-bot` folder:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_APPLICATION_ID=your_application_id_here
DISCORD_PUBLIC_KEY=your_public_key_here
BOT_PREFIX=!
VERIFIED_ROLE_ID=your_verified_role_id_here
REDIS_URL=redis://default:password@host:port
```

Replace the placeholder values with your actual credentials.

**Redis (Optional but Recommended):** Adding `REDIS_URL` enables persistent storage that survives deployments. Without it, pending verifications are stored in a local file (which gets wiped on Railway deploys).

---

### 4b. Set Up Redis on Railway (Recommended)

1. In your Railway project, click **"+ New"** → **"Database"** → **"Redis"**
2. Click on the Redis service and go to **"Variables"**
3. Copy the `REDIS_URL` value
4. Add it to your bot's environment variables in Railway

This ensures verification codes survive deployments and restarts.

---

### 5. Install Dependencies

```bash
cd jaime-tiktok-bot
npm install
```

---

### 6. Run the Bot

```bash
node index.js
```

You should see: `Logged in as YourBotName#1234`

---

## Usage

### Admin Commands

| Command | Description |
|---------|-------------|
| `!setup-verify` | Creates the verification panel in the current channel (Admin only) |
| `!verified-list` | Shows all verified users with their TikTok profiles |
| `!verified-export` | Exports verified users as a JSON file |
| `!test-tiktok` | Tests if the bot can read TikTok bios (health check) |
| `!test-tiktok @username` | Tests reading a specific user's TikTok bio |
| `!manual-verify @user @tiktok` | Manually verify a user without bio check (Admin only) |

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
6. Bot checks their TikTok bio for the code
7. If found, user receives the **Verified** role and is saved to the database

---

## Troubleshooting

### "Used disallowed intents" Error

Make sure you enabled **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT** in the Discord Developer Portal.

### Bot can't assign roles

Ensure the bot's role is **higher** than the Verified Viewer role in Server Settings → Roles.

### "I could not read your TikTok profile"

- The user's TikTok profile must be **public**
- Run `!test-tiktok` to check if the bot can access TikTok
- Check Railway logs for health check results

### TikTok blocking requests

- The bot uses Android mobile headers to bypass blocking
- Health checks run every 4 hours and log results
- Use `!test-tiktok` to manually verify TikTok access

### TikTok CDN caching (bio changes not showing)

- TikTok's CDN can take **several minutes** to propagate bio changes
- The bot polls for up to **10 minutes** (60 attempts, 10 seconds apart)
- If verification fails, users can try again - the bot accepts the **last 5 codes** they generated
- Pending verifications are saved to file, so codes survive bot restarts/redeploys

### Bot not responding to commands

- Make sure the bot has permission to read messages in the channel
- Check that you're using the correct prefix (default: `!`)

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
├── verified-users.json         # Saved verified users (auto-created)
├── pending-verifications.json  # Pending verifications (survives restarts)
├── .env                        # Environment variables (DO NOT COMMIT)
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
| **discord.js v14** | Discord bot framework |
| **Express.js** | Web server for dashboard |
| **ioredis** | Redis client for persistent storage |
| **Vercel** | Website hosting |
| **Railway** | 24/7 bot hosting |
| **Redis** | Persistent pending verifications (survives deploys) |
| **JSON file storage** | Verified users database (fallback for pending) |

---

## License

MIT
