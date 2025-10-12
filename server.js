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
let youtubeFormats = new Map(); // Store YouTube formats by URL
let downloadProgress = new Map(); // Store download progress by request ID

// Optimized download function with DC migration support
async function fastDownloadMedia(client, media, filePath) {
    const fileSize = media.document.size;
    const startTime = Date.now();
    let lastLogTime = startTime;
    let lastProgress = 0;

    console.log(`📦 Optimized download started (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    try {
        // Download to buffer first with maximum workers (faster than streaming to disk)
        const buffer = await client.downloadMedia(media, {
            workers: 32,  // Increased to maximum
            progressCallback: (downloaded, total) => {
                const now = Date.now();
                const currentProgress = ((downloaded / total) * 100).toFixed(1);

                // Log every 2 seconds or every 10% progress
                if (now - lastLogTime > 2000 || (currentProgress - lastProgress >= 10)) {
                    const speed = (downloaded / 1024 / 1024) / ((now - startTime) / 1000);
                    const remaining = total - downloaded;
                    const eta = remaining > 0 ? (remaining / (downloaded / ((now - startTime) / 1000))).toFixed(0) : 0;

                    console.log(`⏬ ${currentProgress}% | ${speed.toFixed(2)} MB/s | ETA: ${eta}s`);
                    lastLogTime = now;
                    lastProgress = currentProgress;
                }
            }
        });

        // Write buffer to file in one go (much faster)
        fs.writeFileSync(filePath, buffer, { flag: 'w' });

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const avgSpeed = (fileSize / 1024 / 1024 / totalTime).toFixed(2);
        console.log(`✅ Download completed in ${totalTime}s (Avg: ${avgSpeed} MB/s)`);

        return true;
    } catch (error) {
        console.error('❌ Download failed:', error.message);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        throw error;
    }
}

// Initialize Telegram Client with better error handling
async function initTelegram() {
    try {
        console.log('🔄 Initializing Telegram client...');

        client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 15,
            retryDelay: 500,  // Faster retries
            autoReconnect: true,
            useWSS: false,
            timeout: 60000,  // Increased to 60s for large downloads
            downloadRetries: 10,
            requestRetries: 5,
            floodSleepThreshold: 60,
            useIPv6: false,
            baseLogger: undefined,  // Disable verbose logging for speed
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

            // Check if it's a text message with format information
            if (message.text) {
                const text = message.text;
                console.log('📨 Received text message from bot:', text.substring(0, 200) + '...');

                // Check if it's YouTube format list
                // Bot can send formats in different ways, so check for multiple indicators
                const isFormatList = (
                    (text.includes('📹') || text.includes('Download formats') || text.includes('format')) &&
                    (text.includes('1080p') || text.includes('720p') || text.includes('480p') || text.includes('MP3'))
                );

                if (isFormatList) {
                    console.log('📋 YouTube formats detected in message!');

                    // Parse formats from message
                    const formats = parseYouTubeFormats(text);

                    if (formats.length > 0) {
                        console.log(`✅ Successfully parsed ${formats.length} formats:`, formats.map(f => f.quality).join(', '));
                    } else {
                        console.warn('⚠️ No formats were parsed from the message. Message text:', text);
                    }

                    // Store formats temporarily (associate with last request)
                    for (let [key, resolve] of pendingDownloads.entries()) {
                        resolve({ type: 'formats', formats: formats });
                        pendingDownloads.delete(key);
                        break;
                    }
                    return;
                }

                // Check if it's a progress message
                if (text.includes('📥 Downloading:') || text.includes('■')) {
                    console.log('⏬ Download progress:', text);

                    // Parse progress percentage
                    const progressMatch = text.match(/(\d+)%/);
                    if (progressMatch) {
                        const progress = parseInt(progressMatch[1]);

                        // Update progress for all active downloads
                        for (let [key, value] of downloadProgress.entries()) {
                            value.progress = progress;
                            value.status = `Downloading: ${progress}%`;
                        }
                    }
                    return;
                }
            }

            // Check if message has video
            if (message.media && message.media.document) {
                const attributes = message.media.document.attributes || [];
                const isVideo = attributes.some(attr =>
                    attr.className === 'DocumentAttributeVideo'
                );

                if (isVideo) {
                    console.log('📹 Video received from bot!');

                    // Save video temporarily
                    const fileName = `video_${Date.now()}.mp4`;
                    const filePath = path.join(__dirname, 'public', 'downloads', fileName);

                    // Create downloads directory if it doesn't exist
                    if (!fs.existsSync(path.join(__dirname, 'public', 'downloads'))) {
                        fs.mkdirSync(path.join(__dirname, 'public', 'downloads'), { recursive: true });
                    }

                    try {
                        // Use custom fast download with 1MB chunks and parallel workers
                        await fastDownloadMedia(client, message.media, filePath);

                        // Store the download info
                        const downloadInfo = {
                            type: 'video',
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

                        // Mark all progress as complete
                        for (let [key, value] of downloadProgress.entries()) {
                            value.progress = 100;
                            value.complete = true;
                            value.success = true;
                            value.videoUrl = downloadInfo.url;
                            value.fileName = downloadInfo.fileName;
                        }
                    } catch (downloadError) {
                        console.error('❌ Error during download:', downloadError);

                        // Clean up partial file if it exists
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                            console.log('🗑️ Cleaned up partial download');
                        }

                        // Reject all pending requests
                        for (let [key, resolve] of pendingDownloads.entries()) {
                            resolve(null);
                            pendingDownloads.delete(key);
                        }

                        // Mark progress as failed
                        for (let [key, value] of downloadProgress.entries()) {
                            value.complete = true;
                            value.success = false;
                            value.error = 'Download failed';
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
}

// Parse YouTube formats from bot message
function parseYouTubeFormats(text) {
    const formats = [];

    // Common format patterns (updated to handle extra spaces before and after colon)
    const formatPatterns = [
        { regex: /1080p\s*:\s*(\d+MB)/i, quality: '1080p' },
        { regex: /720p\s*:\s*(\d+MB)/i, quality: '720p' },
        { regex: /480p\s*:\s*(\d+MB)/i, quality: '480p' },
        { regex: /360p\s*:\s*(\d+MB)/i, quality: '360p' },
        { regex: /240p\s*:\s*(\d+MB)/i, quality: '240p' },
        { regex: /144p\s*:\s*(\d+MB)/i, quality: '144p' },
        { regex: /MP3\s*:\s*(\d+MB)/i, quality: 'MP3' }
    ];

    formatPatterns.forEach(pattern => {
        const match = text.match(pattern.regex);
        if (match) {
            formats.push({
                quality: pattern.quality,
                size: match[1]
            });
        }
    });

    console.log(`📋 Parsed ${formats.length} formats from bot message`);
    return formats;
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

        // Wait for bot response with video (increased timeout for better reliability)
        const downloadPromise = new Promise((resolve) => {
            const requestId = Date.now();
            pendingDownloads.set(requestId, resolve);

            // Timeout after 120 seconds for large files
            setTimeout(() => {
                if (pendingDownloads.has(requestId)) {
                    pendingDownloads.delete(requestId);
                    resolve(null);
                }
            }, 120000);
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

// YouTube formats endpoint
app.post('/api/youtube/formats', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // Check if Telegram is connected
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'Telegram client not connected. Please wait...' });
    }

    try {
        // Find bot entity
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

        // Send YouTube URL to bot
        await client.sendMessage(bot, { message: url });
        console.log(`📤 Sent YouTube URL to bot: ${url}`);

        // Wait for format response
        const formatPromise = new Promise((resolve) => {
            const requestId = Date.now();
            pendingDownloads.set(requestId, resolve);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (pendingDownloads.has(requestId)) {
                    pendingDownloads.delete(requestId);
                    resolve(null);
                }
            }, 30000);
        });

        const result = await formatPromise;

        if (result && result.type === 'formats') {
            console.log(`✅ Sending ${result.formats.length} formats to frontend:`, result.formats);
            res.json({
                success: true,
                formats: result.formats
            });
        } else {
            console.warn('⚠️ No formats received, sending timeout error to frontend');
            res.status(408).json({ error: 'Timeout waiting for formats from bot' });
        }

    } catch (error) {
        console.error('Error in YouTube formats endpoint:', error);
        res.status(500).json({ error: 'Failed to get formats: ' + error.message });
    }
});

// YouTube download endpoint
app.post('/api/youtube/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url || !format) {
        return res.status(400).json({ error: 'URL and format are required' });
    }

    // Check if Telegram is connected
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'Telegram client not connected. Please wait...' });
    }

    try {
        // Find bot entity
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

        // Create progress tracking
        const requestId = Date.now();
        downloadProgress.set(requestId, {
            progress: 0,
            status: 'Starting download...',
            complete: false,
            success: false
        });

        // Send format selection to bot (bot should understand format button click)
        await client.sendMessage(bot, { message: format });
        console.log(`📤 Sent format selection to bot: ${format}`);

        // Return immediately - client will poll for progress
        res.json({
            success: true,
            requestId: requestId
        });

        // Wait for video in background
        const downloadPromise = new Promise((resolve) => {
            pendingDownloads.set(requestId, resolve);

            // Timeout after 120 seconds
            setTimeout(() => {
                if (pendingDownloads.has(requestId)) {
                    pendingDownloads.delete(requestId);
                    resolve(null);
                }
            }, 120000);
        });

        await downloadPromise;

    } catch (error) {
        console.error('Error in YouTube download endpoint:', error);
        res.status(500).json({ error: 'Failed to start download: ' + error.message });
    }
});

// YouTube progress endpoint
app.get('/api/youtube/progress/:id', (req, res) => {
    const requestId = parseInt(req.params.id);

    if (downloadProgress.has(requestId)) {
        const progress = downloadProgress.get(requestId);
        res.json(progress);

        // Clean up completed requests after 60 seconds
        if (progress.complete) {
            setTimeout(() => {
                downloadProgress.delete(requestId);
            }, 60000);
        }
    } else {
        res.json({
            progress: 0,
            status: 'Unknown request',
            complete: true,
            success: false,
            error: 'Request not found'
        });
    }
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
