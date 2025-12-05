# Jaime TikTok Verification Bot

A Discord bot that verifies users' TikTok accounts by checking for a unique code in their TikTok bio.

## Features

- Users click a "Verify TikTok" button to start verification
- Bot generates a unique code (e.g., `JAIME-12345`)
- User adds the code to their TikTok bio temporarily
- Bot checks the TikTok profile and assigns the "Verified Viewer" role if the code is found

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

```
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
```

Replace the placeholder values with your actual credentials.

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

### User Flow

1. User clicks the **"Verify TikTok"** button
2. A modal appears asking for their TikTok username
3. Bot provides a unique verification code
4. User adds the code to their TikTok bio
5. User clicks **"I Added the Code"**
6. Bot checks their TikTok bio for the code
7. If found, user receives the **Verified Viewer** role

---

## Troubleshooting

### "Used disallowed intents" Error
- Make sure you enabled **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT** in the Discord Developer Portal

### Bot can't assign roles
- Ensure the bot's role is **higher** than the Verified Viewer role in Server Settings → Roles

### "I could not read your TikTok profile"
- The user's TikTok profile must be **public**
- TikTok may be blocking requests; try again later

### Bot not responding to commands
- Make sure the bot has permission to read messages in the channel
- Check that you're using the correct prefix (default: `!`)

---

## File Structure

```
jaime-tiktok-bot/
├── index.js          # Main bot code
├── package.json      # Dependencies
├── .env              # Environment variables (DO NOT COMMIT)
├── .env.example      # Example environment file
├── .gitignore        # Git ignore rules
└── README.md         # This file
```

---

## Security Notes

- **Never commit your `.env` file** - it contains sensitive tokens
- The `.gitignore` file is configured to exclude `.env`
- If your bot token is ever exposed, regenerate it immediately in the Discord Developer Portal

---

## Requirements

- Node.js 18+ (for native fetch support)
- discord.js v14+
- dotenv

---

## License

MIT
