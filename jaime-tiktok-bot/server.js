require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCORD_CLIENT_ID = process.env.DISCORD_APPLICATION_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/callback`;

// Store for OAuth states and tokens (in production, use a database)
const states = new Map();
const userTokens = new Map();

// Serve static files (terms.html, privacy.html)
app.use(express.static(__dirname));

// Home page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Jaime TikTok Verification</title>
      <style>
        body { font-family: sans-serif; background: #1a1a2e; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { text-align: center; padding: 40px; background: #16213e; border-radius: 12px; }
        h1 { margin-bottom: 20px; }
        a { color: #5865F2; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>💀 Jaime TikTok Verification Bot</h1>
        <p>Verify your TikTok account on Discord</p>
        <p><a href="/linked-role">Link your Discord account</a></p>
        <p><a href="/terms.html">Terms of Service</a> | <a href="/privacy.html">Privacy Policy</a></p>
      </div>
    </body>
    </html>
  `);
});

// Start OAuth2 flow for Linked Roles
app.get('/linked-role', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, { timestamp: Date.now() });

  // Clean up old states (older than 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of states) {
    if (value.timestamp < tenMinutesAgo) states.delete(key);
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    state: state,
    scope: 'identify role_connections.write',
    prompt: 'consent',
  });

  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// OAuth2 callback
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  // Verify state
  if (!state || !states.has(state)) {
    return res.status(400).send('Invalid state parameter. Please try again.');
  }
  states.delete(state);

  if (!code) {
    return res.status(400).send('No authorization code received.');
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      console.error('Token error:', tokens);
      return res.status(400).send('Failed to get access token.');
    }

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    const user = await userResponse.json();

    // Store tokens (in production, store in database)
    userTokens.set(user.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    // Update the user's role connection metadata
    // This sets them as "verified" via the linked role
    await updateRoleConnection(tokens.access_token, {
      tiktok_verified: true,
      verified_at: new Date().toISOString(),
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Verification Complete</title>
        <style>
          body { font-family: sans-serif; background: #1a1a2e; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .container { text-align: center; padding: 40px; background: #16213e; border-radius: 12px; }
          h1 { color: #5865F2; }
          .success { color: #43b581; font-size: 48px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">✓</div>
          <h1>Account Linked!</h1>
          <p>Your Discord account has been linked for TikTok verification.</p>
          <p>You can now close this window and return to Discord.</p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).send('An error occurred during verification.');
  }
});

// Update role connection metadata
async function updateRoleConnection(accessToken, metadata) {
  const response = await fetch(
    `https://discord.com/api/users/@me/applications/${DISCORD_CLIENT_ID}/role-connection`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platform_name: 'TikTok',
        platform_username: metadata.tiktok_username || 'Verified User',
        metadata: {
          tiktok_verified: metadata.tiktok_verified ? 1 : 0,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    console.error('Role connection error:', error);
    throw new Error('Failed to update role connection');
  }

  return response.json();
}

// Register role connection metadata schema (run once)
app.get('/register-metadata', async (req, res) => {
  const botToken = process.env.DISCORD_TOKEN;

  const metadata = [
    {
      key: 'tiktok_verified',
      name: 'TikTok Verified',
      description: 'User has verified their TikTok account',
      type: 7, // Boolean
    },
  ];

  try {
    const response = await fetch(
      `https://discord.com/api/applications/${DISCORD_CLIENT_ID}/role-connections/metadata`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
      }
    );

    const result = await response.json();
    
    if (!response.ok) {
      console.error('Metadata registration error:', result);
      return res.status(400).json(result);
    }

    res.json({ success: true, metadata: result });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Linked Role URL: http://localhost:${PORT}/linked-role`);
  console.log(`\nMake sure to set these in Discord Developer Portal:`);
  console.log(`  Redirects: ${DISCORD_REDIRECT_URI}`);
  console.log(`  Linked Roles Verification URL: http://localhost:${PORT}/linked-role`);
});
