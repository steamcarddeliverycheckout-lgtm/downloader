require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, Raw } = require('telegram/events');
const input = require('input');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Configuration - Allowed domains for API access
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'https://h4k3r.space',
    'https://www.h4k3r.space'
];

// CORS Security Middleware - Only allow requests from specific domains
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, Postman)
        if (!origin) return callback(null, true);

        // Check if origin is in allowed list
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log(`❌ Blocked request from unauthorized origin: ${origin}`);
            callback(new Error('Not allowed by CORS - Unauthorized domain'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Rate limiting middleware (prevent abuse)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max 10 requests per minute per IP

function rateLimitMiddleware(req, res, next) {
    const clientIp = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    if (!rateLimitMap.has(clientIp)) {
        rateLimitMap.set(clientIp, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return next();
    }

    const rateLimitData = rateLimitMap.get(clientIp);

    if (now > rateLimitData.resetTime) {
        // Reset counter after time window
        rateLimitMap.set(clientIp, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return next();
    }

    if (rateLimitData.count >= MAX_REQUESTS_PER_WINDOW) {
        console.log(`⚠️ Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
            error: 'Too many requests. Please try again later.',
            retryAfter: Math.ceil((rateLimitData.resetTime - now) / 1000)
        });
    }

    rateLimitData.count++;
    next();
}

// Apply rate limiting to API endpoints
app.use('/api/', rateLimitMiddleware);

// Telegram Configuration
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');
const botUsername = process.env.BOT_USERNAME || '@Ebenozdownbot';

let client;
let pendingDownloads = new Map();
let isConnected = false;
let reconnectTimeout = null;
let isReconnecting = false; // Prevent concurrent reconnections
let youtubeFormats = new Map(); // Store YouTube formats by URL
let downloadProgress = new Map(); // Store download progress by request ID
let lastFormatMessage = null; // Store the last bot message with format buttons
let receivedMediaTypes = new Map(); // Track what media types we've already received for each request

// Optimized download function with DC migration support
async function fastDownloadMedia(client, media, filePath) {
    const fileSize = media.document.size;
    const startTime = Date.now();

    console.log(`📦 Starting download: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    try {
        // Download to buffer with maximum workers (faster than streaming to disk)
        const buffer = await client.downloadMedia(media, {
            workers: 32,  // Maximum parallel workers
            progressCallback: (downloaded, total) => {
                // Only log at 25%, 50%, 75% to reduce overhead
                const progress = ((downloaded / total) * 100).toFixed(0);
                if (progress === '25' || progress === '50' || progress === '75') {
                    const speed = (downloaded / 1024 / 1024) / ((Date.now() - startTime) / 1000);
                    console.log(`⏬ ${progress}% | ${speed.toFixed(1)} MB/s`);
                }
            }
        });

        // Write buffer to file in one go (much faster than streaming)
        fs.writeFileSync(filePath, buffer, { flag: 'w' });

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const avgSpeed = (fileSize / 1024 / 1024 / totalTime).toFixed(2);
        console.log(`✅ Downloaded in ${totalTime}s (${avgSpeed} MB/s)`);

        return true;
    } catch (error) {
        console.error('❌ Download failed:', error.message);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        throw error;
    }
}

// Silent logger to suppress Telegram library logs
class SilentLogger {
    log() {} // Do nothing
    info() {}
    warn() {}
    error() {}
    debug() {}
}

// Initialize Telegram Client with better error handling
async function initTelegram() {
    try {
        console.log('🚀 Connecting...');

        client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 15,
            retryDelay: 300,  // Faster retries
            autoReconnect: true,
            useWSS: false,
            timeout: 60000,
            downloadRetries: 10,
            requestRetries: 5,
            floodSleepThreshold: 60,
            useIPv6: false,
            baseLogger: new SilentLogger(),  // Completely silent
        });

        // Handle connection errors
        client.on('error', (error) => {
            // Only log if AUTH_KEY_DUPLICATED or critical
            if (error.message && error.message.includes('AUTH_KEY_DUPLICATED')) {
                console.error('🚨 AUTH_KEY_DUPLICATED');
                isConnected = false;
                isReconnecting = false;
                return;
            }
            isConnected = false;
            scheduleReconnect();
        });

        await client.start({
            phoneNumber: async () => '',
            password: async () => '',
            phoneCode: async () => '',
            onError: (err) => {
                isConnected = false;
            },
        });

        console.log('✅ Connected');
        isConnected = true;
        isReconnecting = false;

        // Listen for ALL incoming messages (including edited ones)
        // NewMessage event catches both new and edited messages in gramJS
        client.addEventHandler(handleIncomingMessage, new NewMessage({}));

        // Listen for edited messages
        client.addEventHandler(async (update) => {
            try {
                if (update instanceof Api.UpdateEditMessage ||
                    update instanceof Api.UpdateEditChannelMessage) {
                    const messageId = update.message?.id;
                    const peer = update.message?.peerId;
                    if (!messageId || !peer) return;

                    try {
                        const messages = await client.getMessages(peer, { ids: [messageId] });
                        if (messages && messages.length > 0) {
                            await handleIncomingMessage({ message: messages[0] });
                        }
                    } catch (fetchError) {
                        // Silent fail
                    }
                }
            } catch (error) {
                // Silent fail
            }
        }, new Raw({}));

        startKeepAlive();

    } catch (error) {
        console.error('❌ Connection failed');
        isConnected = false;
        isReconnecting = false;

        // Special handling for AUTH_KEY_DUPLICATED
        if (error.message && error.message.includes('AUTH_KEY_DUPLICATED')) {
            console.error('🚨 AUTH_KEY_DUPLICATED - Check for multiple instances');
            return; // Don't schedule reconnect
        }

        scheduleReconnect();
    }
}

// Keep connection alive
function startKeepAlive() {
    setInterval(async () => {
        if (client && isConnected) {
            try {
                await client.getMe();
                // Silent - no log
            } catch (error) {
                isConnected = false;
                scheduleReconnect();
            }
        }
    }, 60000); // Check every 60 seconds (less frequent)
}

// Schedule reconnection
function scheduleReconnect() {
    if (isReconnecting) return;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    reconnectTimeout = setTimeout(async () => {
        if (isReconnecting) return;

        isReconnecting = true;

        try {
            if (client) {
                try {
                    await client.disconnect();
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (disconnectError) {
                    // Silent
                }
                client = null;
            }

            await new Promise(resolve => setTimeout(resolve, 3000));
            await initTelegram();

        } catch (error) {
            isReconnecting = false;

            if (error.message && error.message.includes('AUTH_KEY_DUPLICATED')) {
                console.error('🚨 AUTH_KEY_DUPLICATED - Stop');
                return;
            }

            setTimeout(() => {
                isReconnecting = false;
                scheduleReconnect();
            }, 10000);
        }
    }, 5000);
}

// Handle incoming messages from bot
async function handleIncomingMessage(event) {
    try {
        const message = event.message;
        if (!message) return;

        // Check if message is from @Ebenozdownbot ONLY
        const sender = await message.getSender();
        const senderUsername = sender?.username || '';
        const targetBotName = botUsername.replace('@', '');

        if (senderUsername !== targetBotName) return; // Ignore other messages

        // Check for YouTube format list
        if (message.text) {
            const text = message.text;

            const isFormatList = (
                (text.includes('📹') || text.includes('🎬')) &&
                (text.includes('144p') || text.includes('240p') || text.includes('360p') ||
                 text.includes('480p') || text.includes('720p') || text.includes('1080p') || text.includes('MP3'))
            );

            if (isFormatList) {
                lastFormatMessage = message;
                const formats = parseYouTubeFormats(text);

                for (let [key, resolve] of pendingDownloads.entries()) {
                    resolve({ type: 'formats', formats: formats });
                    pendingDownloads.delete(key);
                    break;
                }
                return;
            }

            // Track progress messages
            if (text.includes('📥 Downloading') || text.includes('■')) {
                const progressMatch = text.match(/(\d+)%/);
                if (progressMatch) {
                    const progress = parseInt(progressMatch[1]);
                    for (let [key, value] of downloadProgress.entries()) {
                        if (!value.complete) {
                            value.progress = progress;
                            value.status = `Downloading: ${progress}%`;
                        }
                    }
                }
                return;
            }
        }

        // Check if we're waiting for media
        const waitingForMedia = pendingDownloads.size > 0 ||
            Array.from(downloadProgress.values()).some(p => !p.complete);

        if (!waitingForMedia) return;
        if (!message.media) return;

        const mediaClassName = message.media.className;

        // Handle MessageMediaPhoto
        if (mediaClassName === 'MessageMediaPhoto') {
            console.log('📸 Downloading image...');

            const fileName = `image_${Date.now()}.jpg`;
            const filePath = path.join(__dirname, 'public', 'downloads', fileName);

            const downloadsDir = path.join(__dirname, 'public', 'downloads');
            if (!fs.existsSync(downloadsDir)) {
                fs.mkdirSync(downloadsDir, { recursive: true });
            }

            try {
                const buffer = await client.downloadMedia(message.media, { workers: 16 });
                fs.writeFileSync(filePath, buffer, { flag: 'w' });

                const downloadInfo = {
                    type: 'image',
                    mediaType: 'image',
                    fileName: fileName,
                    url: `/downloads/${fileName}`,
                    timestamp: Date.now()
                };

                console.log('✅ Image ready');

                // Mark and resolve
                for (let [key] of pendingDownloads.entries()) {
                    receivedMediaTypes.set(key, 'image');
                }

                for (let [key, resolve] of pendingDownloads.entries()) {
                    resolve(downloadInfo);
                    pendingDownloads.delete(key);
                }

                for (let [key, value] of downloadProgress.entries()) {
                    if (!value.complete) {
                        value.progress = 100;
                        value.complete = true;
                        value.success = true;
                        value.videoUrl = downloadInfo.url;
                        value.fileName = downloadInfo.fileName;
                        value.mediaType = downloadInfo.mediaType;
                    }
                }

                setTimeout(() => {
                    for (let key of Array.from(receivedMediaTypes.keys())) {
                        receivedMediaTypes.delete(key);
                    }
                }, 5000);

                return;

            } catch (error) {
                console.error('❌ Image download failed');
                for (let [key, resolve] of pendingDownloads.entries()) {
                    resolve(null);
                    pendingDownloads.delete(key);
                }
                return;
            }
        }

        // Handle MessageMediaDocument
        if (!message.media.document) return;

        const mimeType = message.media.document.mimeType || '';
        const attributes = message.media.document.attributes || [];

        // Detect media type
        const isVideo = attributes.some(attr => attr.className === 'DocumentAttributeVideo') ||
                        mimeType.includes('video');
        const isAudio = attributes.some(attr => attr.className === 'DocumentAttributeAudio') ||
                        mimeType.includes('audio') || mimeType.includes('mpeg') ||
                        mimeType.includes('mp3') || mimeType.includes('ogg') ||
                        mimeType.includes('wav') || mimeType.includes('m4a');
        const isImage = mimeType.includes('image/') ||
                        attributes.some(attr => attr.className === 'DocumentAttributeImageSize');

        // Priority: Video > Image > Audio (skip audio if video/image received)
        if (isAudio && !isVideo && !isImage) {
            const alreadyReceivedBetter = Array.from(receivedMediaTypes.values()).some(type =>
                type === 'video' || type === 'image'
            );
            if (alreadyReceivedBetter || pendingDownloads.size > 0) return; // Skip audio
        }

        // Infer type if unknown
        if (!isVideo && !isAudio && !isImage) {
            if (mimeType.includes('video') || mimeType.includes('mp4') || mimeType.includes('webm')) {
                isVideo = true;
            } else if (mimeType.includes('audio') || mimeType.includes('mpeg')) {
                isAudio = true;
            } else if (mimeType.includes('image')) {
                isImage = true;
            } else {
                return; // Unknown type, ignore
            }
        }

        if (!isVideo && !isAudio && !isImage) return;

        const mediaType = isVideo ? 'VIDEO' : (isAudio ? 'AUDIO' : 'IMAGE');
        console.log(`🎯 ${mediaType} (${(message.media.document.size / 1024 / 1024).toFixed(1)}MB)`);

        // Get file extension
        let fileExt = '.jpg';
        let filePrefix = 'media';

        if (isVideo) {
            filePrefix = 'video';
            if (mimeType.includes('video/webm')) fileExt = '.webm';
            else if (mimeType.includes('video/mp4')) fileExt = '.mp4';
            else if (mimeType.includes('video/quicktime')) fileExt = '.mov';
            else if (mimeType.includes('video/x-matroska')) fileExt = '.mkv';
            else fileExt = '.mp4';
        } else if (isAudio) {
            filePrefix = 'audio';
            if (mimeType.includes('audio/mpeg') || mimeType.includes('mp3')) fileExt = '.mp3';
            else if (mimeType.includes('audio/ogg')) fileExt = '.ogg';
            else if (mimeType.includes('audio/wav')) fileExt = '.wav';
            else if (mimeType.includes('audio/m4a') || mimeType.includes('audio/mp4')) fileExt = '.m4a';
            else if (mimeType.includes('audio/aac')) fileExt = '.aac';
            else if (mimeType.includes('audio/flac')) fileExt = '.flac';
            else if (mimeType.includes('audio/opus')) fileExt = '.opus';
            else fileExt = '.mp3';
        } else if (isImage) {
            filePrefix = 'image';
            if (mimeType.includes('image/jpeg') || mimeType.includes('image/jpg')) fileExt = '.jpg';
            else if (mimeType.includes('image/png')) fileExt = '.png';
            else if (mimeType.includes('image/gif')) fileExt = '.gif';
            else if (mimeType.includes('image/webp')) fileExt = '.webp';
            else if (mimeType.includes('image/bmp')) fileExt = '.bmp';
            else if (mimeType.includes('image/svg')) fileExt = '.svg';
            else fileExt = '.jpg';
        }

        const fileName = `${filePrefix}_${Date.now()}${fileExt}`;
        const filePath = path.join(__dirname, 'public', 'downloads', fileName);

        const downloadsDir = path.join(__dirname, 'public', 'downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }

        try {
            await fastDownloadMedia(client, message.media, filePath);

            const downloadInfo = {
                type: isAudio ? 'audio' : (isImage ? 'image' : 'video'),
                mediaType: mediaType.toLowerCase(),
                fileName: fileName,
                url: `/downloads/${fileName}`,
                timestamp: Date.now()
            };

            console.log(`✅ Ready`);

            // Mark and resolve
            for (let [key] of pendingDownloads.entries()) {
                receivedMediaTypes.set(key, mediaType.toLowerCase());
            }

            for (let [key, resolve] of pendingDownloads.entries()) {
                resolve(downloadInfo);
                pendingDownloads.delete(key);
            }

            for (let [key, value] of downloadProgress.entries()) {
                if (!value.complete) {
                    value.progress = 100;
                    value.complete = true;
                    value.success = true;
                    value.videoUrl = downloadInfo.url;
                    value.fileName = downloadInfo.fileName;
                    value.mediaType = downloadInfo.mediaType;
                }
            }

            setTimeout(() => {
                for (let key of Array.from(receivedMediaTypes.keys())) {
                    receivedMediaTypes.delete(key);
                }
            }, 5000);

        } catch (downloadError) {
            console.error('❌ Failed');
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            for (let [key, resolve] of pendingDownloads.entries()) {
                resolve(null);
                pendingDownloads.delete(key);
            }

            for (let [key, value] of downloadProgress.entries()) {
                if (!value.complete) {
                    value.complete = true;
                    value.success = false;
                    value.error = 'Download failed';
                }
            }
        }

    } catch (error) {
        // Silent
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
                fileName: result.fileName,
                mediaType: result.mediaType || 'video' // Include media type for frontend
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
            progress: 5,
            status: 'Requesting video from bot...',
            complete: false,
            success: false,
            startTime: Date.now()
        });

        // Check if we have the format message with buttons
        if (!lastFormatMessage) {
            console.error('❌ No format message stored, cannot click button');
            return res.status(400).json({ error: 'No format selection available. Please try again.' });
        }

        console.log(`🔘 Attempting to click button for format: ${format}`);

        try {
            // Get the inline keyboard from the message
            const buttons = lastFormatMessage.replyMarkup?.rows || [];
            console.log(`📋 Found ${buttons.length} button rows in message`);

            let buttonClicked = false;

            // Find and click the button matching the format
            for (let row of buttons) {
                for (let button of row.buttons) {
                    const buttonText = button.text || '';
                    console.log(`🔍 Checking button: "${buttonText}"`);

                    // Check if button text matches the format (e.g., "1080p", "720p")
                    if (buttonText.includes(format)) {
                        console.log(`✅ Found matching button: "${buttonText}"`);

                        // Click the button
                        await lastFormatMessage.click({ data: button.data });
                        console.log(`🖱️ Clicked button for ${format}`);
                        buttonClicked = true;

                        // Update progress status
                        if (downloadProgress.has(requestId)) {
                            downloadProgress.get(requestId).progress = 10;
                            downloadProgress.get(requestId).status = `Processing ${format} video...`;
                        }

                        break;
                    }
                }
                if (buttonClicked) break;
            }

            if (!buttonClicked) {
                console.warn(`⚠️ Could not find button for format: ${format}`);
                console.log('Available buttons:', buttons.map(row =>
                    row.buttons.map(b => b.text).join(', ')
                ).join(' | '));

                // Fallback: send text message
                console.log('📤 Falling back to text message');
                await client.sendMessage(bot, { message: format });
            }
        } catch (clickError) {
            console.error('❌ Error clicking button:', clickError);
            console.log('📤 Falling back to text message');
            // Fallback to text message if button click fails
            await client.sendMessage(bot, { message: format });
        }

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
                    console.error(`⏱️ Timeout waiting for video (requestId: ${requestId})`);
                    pendingDownloads.delete(requestId);

                    // Mark as failed in progress
                    if (downloadProgress.has(requestId)) {
                        downloadProgress.get(requestId).complete = true;
                        downloadProgress.get(requestId).success = false;
                        downloadProgress.get(requestId).error = 'Download timeout - bot did not send video';
                        console.log(`❌ Marked request ${requestId} as failed due to timeout`);
                    }

                    resolve(null);
                }
            }, 120000);
        });

        const result = await downloadPromise;

        if (!result) {
            console.error(`❌ Download failed or timed out for requestId: ${requestId}`);
        }

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

// Download endpoint with proper headers
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'public', 'downloads', filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    // Get file extension and set proper MIME type
    const ext = path.extname(filename).toLowerCase();
    let mimeType = 'application/octet-stream'; // default

    // Video MIME types
    if (ext === '.webm') {
        mimeType = 'video/webm';
    } else if (ext === '.mov') {
        mimeType = 'video/quicktime';
    } else if (ext === '.mp4') {
        mimeType = 'video/mp4';
    } else if (ext === '.mkv') {
        mimeType = 'video/x-matroska';
    }
    // Audio MIME types
    else if (ext === '.mp3') {
        mimeType = 'audio/mpeg';
    } else if (ext === '.ogg') {
        mimeType = 'audio/ogg';
    } else if (ext === '.wav') {
        mimeType = 'audio/wav';
    } else if (ext === '.m4a') {
        mimeType = 'audio/mp4';
    } else if (ext === '.aac') {
        mimeType = 'audio/aac';
    } else if (ext === '.flac') {
        mimeType = 'audio/flac';
    } else if (ext === '.opus') {
        mimeType = 'audio/opus';
    }
    // Image MIME types
    else if (ext === '.jpg' || ext === '.jpeg') {
        mimeType = 'image/jpeg';
    } else if (ext === '.png') {
        mimeType = 'image/png';
    } else if (ext === '.gif') {
        mimeType = 'image/gif';
    } else if (ext === '.webp') {
        mimeType = 'image/webp';
    } else if (ext === '.bmp') {
        mimeType = 'image/bmp';
    } else if (ext === '.svg') {
        mimeType = 'image/svg+xml';
    }

    // Check if download is requested (vs just playing)
    const forceDownload = req.query.download === 'true';

    // Set headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (forceDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }

    // Get file size
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);

    // Handle range requests for video seeking
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', chunksize);

        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
    } else {
        // Send entire file
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    }
});

// Serve static files (after custom routes so download route takes precedence)
app.use(express.static('public'));

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await initTelegram();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');

    // Clear reconnect timeout
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Prevent reconnection during shutdown
    isReconnecting = true;
    isConnected = false;

    // Disconnect client
    if (client) {
        try {
            console.log('🔌 Disconnecting Telegram client...');
            await client.disconnect();
            console.log('✅ Telegram client disconnected');
        } catch (error) {
            console.error('⚠️ Error during disconnect:', error.message);
        }
    }

    console.log('👋 Shutdown complete');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Received SIGTERM, shutting down...');

    // Clear reconnect timeout
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Prevent reconnection during shutdown
    isReconnecting = true;
    isConnected = false;

    // Disconnect client
    if (client) {
        try {
            console.log('🔌 Disconnecting Telegram client...');
            await client.disconnect();
            console.log('✅ Telegram client disconnected');
        } catch (error) {
            console.error('⚠️ Error during disconnect:', error.message);
        }
    }

    console.log('👋 Shutdown complete');
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
