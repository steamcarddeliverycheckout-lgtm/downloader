require('dotenv').config();
const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Telegram Configuration
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');
const botUsername = process.env.BOT_USERNAME || '@Ebenozdownbot';

let client;
let pendingDownloads = new Map();
let isConnected = false;
let reconnectTimeout = null;

// Initialize Telegram Client with better error handling
async function initTelegram() {
    try {
        console.log('🔄 Initializing Telegram client...');

        client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 10,
            retryDelay: 2000,
            autoReconnect: true,
            useWSS: false,
            timeout: 30000,
        });

        // Handle connection errors
        client.on('error', (error) => {
            console.error('❌ Telegram client error:', error);
            isConnected = false;
            scheduleReconnect();
        });

        await client.start({
            phoneNumber: async () => {
                console.log('Phone number required - using session string');
                return '';
            },
            password: async () => '',
            phoneCode: async () => '',
            onError: (err) => {
                console.error('Connection error:', err);
                isConnected = false;
            },
        });

        console.log('✅ Telegram client connected successfully!');
        console.log('Session String:', client.session.save());
        isConnected = true;

        // Listen for incoming messages with proper event handler
        client.addEventHandler(handleIncomingMessage, new NewMessage({}));

        // Keep connection alive with ping
        startKeepAlive();

    } catch (error) {
        console.error('❌ Error initializing Telegram:', error);
        isConnected = false;
        scheduleReconnect();
    }
}

// Keep connection alive
function startKeepAlive() {
    setInterval(async () => {
        if (client && isConnected) {
            try {
                await client.getMe();
                console.log('🟢 Connection alive');
            } catch (error) {
                console.error('❌ Keep-alive failed:', error);
                isConnected = false;
                scheduleReconnect();
            }
        }
    }, 30000); // Check every 30 seconds
}

// Schedule reconnection
function scheduleReconnect() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    reconnectTimeout = setTimeout(async () => {
        console.log('🔄 Attempting to reconnect...');
        try {
            if (client) {
                await client.disconnect();
            }
            await initTelegram();
        } catch (error) {
            console.error('❌ Reconnection failed:', error);
            scheduleReconnect();
        }
    }, 5000);
}

// Handle incoming messages from bot
async function handleIncomingMessage(event) {
    try {
        const message = event.message;

        if (!message) return;

        // Check if message is from the bot
        const sender = await message.getSender();
        if (sender && sender.username === botUsername.replace('@', '')) {

            // Check if message has video
            if (message.media && message.media.document) {
                const attributes = message.media.document.attributes || [];
                const isVideo = attributes.some(attr =>
                    attr.className === 'DocumentAttributeVideo'
                );

                if (isVideo) {
                    console.log('📹 Video received from bot!');

                    // Download the video
                    const buffer = await client.downloadMedia(message.media, {});

                    // Save video temporarily
                    const fileName = `video_${Date.now()}.mp4`;
                    const filePath = path.join(__dirname, 'public', 'downloads', fileName);

                    // Create downloads directory if it doesn't exist
                    if (!fs.existsSync(path.join(__dirname, 'public', 'downloads'))) {
                        fs.mkdirSync(path.join(__dirname, 'public', 'downloads'), { recursive: true });
                    }

                    fs.writeFileSync(filePath, buffer);

                    // Store the download info
                    const downloadInfo = {
                        fileName: fileName,
                        url: `/downloads/${fileName}`,
                        timestamp: Date.now()
                    };

                    // Find pending request and resolve it
                    for (let [key, resolve] of pendingDownloads.entries()) {
                        resolve(downloadInfo);
                        pendingDownloads.delete(key);
                        break;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
}

// API endpoint to send link to bot
app.post('/api/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // Check if Telegram is connected
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'Telegram client not connected. Please wait...' });
    }

    try {
        // Find bot entity with retry
        let bot;
        let retries = 3;
        while (retries > 0) {
            try {
                bot = await client.getEntity(botUsername);
                break;
            } catch (error) {
                console.error(`Failed to get bot entity, retries left: ${retries - 1}`);
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Send URL to bot
        await client.sendMessage(bot, { message: url });
        console.log(`📤 Sent URL to bot: ${url}`);

        // Wait for bot response with video
        const downloadPromise = new Promise((resolve) => {
            const requestId = Date.now();
            pendingDownloads.set(requestId, resolve);

            // Timeout after 90 seconds
            setTimeout(() => {
                if (pendingDownloads.has(requestId)) {
                    pendingDownloads.delete(requestId);
                    resolve(null);
                }
            }, 90000);
        });

        const result = await downloadPromise;

        if (result) {
            res.json({
                success: true,
                videoUrl: result.url,
                fileName: result.fileName
            });
        } else {
            res.status(408).json({ error: 'Download timeout or no video received from bot' });
        }

    } catch (error) {
        console.error('Error in download endpoint:', error);

        // Check if it's a connection error
        if (error.message && error.message.includes('not connected')) {
            isConnected = false;
            scheduleReconnect();
            return res.status(503).json({ error: 'Connection lost. Reconnecting...' });
        }

        res.status(500).json({ error: 'Failed to process download: ' + error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        telegram: isConnected ? 'connected' : 'disconnected'
    });
});

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await initTelegram();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    if (client && isConnected) {
        try {
            await client.disconnect();
        } catch (error) {
            console.error('Error during disconnect:', error);
        }
    }

    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Received SIGTERM, shutting down...');

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    if (client && isConnected) {
        try {
            await client.disconnect();
        } catch (error) {
            console.error('Error during disconnect:', error);
        }
    }

    process.exit(0);
});

// Clean up old downloads every hour
setInterval(() => {
    const downloadsDir = path.join(__dirname, 'public', 'downloads');
    if (fs.existsSync(downloadsDir)) {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();

        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            const fileAge = now - stats.mtimeMs;

            // Delete files older than 1 hour
            if (fileAge > 3600000) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Deleted old file: ${file}`);
            }
        });
    }
}, 3600000);
