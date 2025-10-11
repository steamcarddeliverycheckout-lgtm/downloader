require('dotenv').config();
const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
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

// Initialize Telegram Client
async function initTelegram() {
    try {
        client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
        });

        await client.start({
            phoneNumber: async () => await input.text('Please enter your phone number: '),
            password: async () => await input.text('Please enter your password: '),
            phoneCode: async () => await input.text('Please enter the code you received: '),
            onError: (err) => console.log(err),
        });

        console.log('✅ Telegram client connected successfully!');
        console.log('Session String:', client.session.save());

        // Listen for incoming messages
        client.addEventHandler(handleIncomingMessage);

    } catch (error) {
        console.error('❌ Error initializing Telegram:', error);
    }
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

    try {
        // Find bot entity
        const bot = await client.getEntity(botUsername);

        // Send URL to bot
        await client.sendMessage(bot, { message: url });
        console.log(`📤 Sent URL to bot: ${url}`);

        // Wait for bot response with video
        const downloadPromise = new Promise((resolve) => {
            const requestId = Date.now();
            pendingDownloads.set(requestId, resolve);

            // Timeout after 60 seconds
            setTimeout(() => {
                if (pendingDownloads.has(requestId)) {
                    pendingDownloads.delete(requestId);
                    resolve(null);
                }
            }, 60000);
        });

        const result = await downloadPromise;

        if (result) {
            res.json({
                success: true,
                videoUrl: result.url,
                fileName: result.fileName
            });
        } else {
            res.status(408).json({ error: 'Download timeout or no video received' });
        }

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Failed to process download' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        telegram: client ? 'connected' : 'disconnected'
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
    if (client) {
        await client.disconnect();
    }
    process.exit(0);
});
