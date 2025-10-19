require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, Raw } = require('telegram/events');
const input = require('input');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Configuration - Allowed domains for API access
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'https://h4k3r.space',
    'https://www.h4k3r.space',
    'https://saver-bst6.onrender.com'
];

// CORS Security Middleware - Only allow requests from specific domains
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, Postman, local file)
        // Also allow 'null' string which happens in some environments
        if (!origin || origin === 'null') {
            return callback(null, true);
        }

        // Check if origin is in allowed list
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log(`❌ Blocked request from unauthorized origin: ${origin}`);
            // For development, allow it but log warning
            // In production, you can uncomment the next line to block
            // callback(new Error('Not allowed by CORS - Unauthorized domain'));
            callback(null, true); // Allow for now, but log the warning
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
const MAX_REQUESTS_PER_WINDOW = 30; // Max 30 requests per minute per IP (increased for testing)

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

// Multer configuration for file uploads
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Use original filename with timestamp to avoid conflicts
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const basename = path.basename(file.originalname, ext);
        cb(null, basename + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Telegram Configuration
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');
const botUsername = process.env.BOT_USERNAME || '@Ebenozdownbot';
const teraboxBotUsername = process.env.TERABOX_BOT_USERNAME || '@TeraBoxFastDLBot';
const fileToLinkBotUsername = process.env.FILETOLINK_BOT_USERNAME || '@ARFileToLinkRoBot';

let client;
let pendingDownloads = new Map();
let isConnected = false;
let reconnectTimeout = null;
let isReconnecting = false; // Prevent concurrent reconnections
let youtubeFormats = new Map(); // Store YouTube formats by URL
let downloadProgress = new Map(); // Store download progress by request ID
let lastFormatMessage = null; // Store the last bot message with format buttons
let receivedMediaTypes = new Map(); // Track what media types we've already received for each request
let teraboxPendingDownloads = new Map(); // Separate map for TeraBox downloads
let teraboxWebAppUrls = new Map(); // Store Web App URLs from TeraBox bot
let fileToLinkPendingUploads = new Map(); // Store pending file-to-link upload requests

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

        // Check if message is from @Ebenozdownbot OR @TeraBoxFastDLBot OR @ARFileToLinkRoBot
        const sender = await message.getSender();
        const senderUsername = sender?.username || '';
        const targetBotName = botUsername.replace('@', '');
        const teraboxBotName = teraboxBotUsername.replace('@', '');
        const fileToLinkBotName = fileToLinkBotUsername.replace('@', '');

        if (senderUsername !== targetBotName && senderUsername !== teraboxBotName && senderUsername !== fileToLinkBotName) return; // Ignore other messages

        // Handle TeraBox bot responses
        if (senderUsername === teraboxBotName) {
            // PRIORITY 1: Check if bot sent direct video/media first
            if (message.media && message.media.document) {
                console.log('📹 TeraBox sent direct video - Processing...');
                // Don't return here, let it process as regular download below
                // This ensures we download actual video instead of Web App URL
            }
            // PRIORITY 2: Only check for Web App URL if NO direct media
            else if (message.replyMarkup && message.replyMarkup.rows) {
                for (let row of message.replyMarkup.rows) {
                    for (let button of row.buttons) {
                        if (button.url) {
                            // Found Web App URL (fallback option)
                            console.log('🌐 TeraBox Web App URL found (no direct video):', button.url);

                            for (let [key, resolve] of teraboxPendingDownloads.entries()) {
                                resolve({ type: 'webapp', url: button.url });
                                teraboxPendingDownloads.delete(key);
                                break;
                            }
                            return;
                        }
                    }
                }
            }
        }

        // Handle FileToLink bot responses
        if (senderUsername === fileToLinkBotName) {
            // PRIORITY 1: Check for download button in reply markup
            if (message.replyMarkup && message.replyMarkup.rows) {
                for (let row of message.replyMarkup.rows) {
                    for (let button of row.buttons) {
                        // Look for download button (usually has "Download" text or URL)
                        if (button.url && (button.text.includes('Download') || button.text.includes('⬇️') || button.url.includes('file'))) {
                            const downloadLink = button.url;
                            console.log('✅ Download button link found:', downloadLink);

                            // Resolve pending upload
                            for (let [key, resolve] of fileToLinkPendingUploads.entries()) {
                                resolve({ success: true, downloadLink: downloadLink, fullMessage: message.text || '' });
                                fileToLinkPendingUploads.delete(key);
                                break;
                            }
                            return;
                        }
                    }
                }
            }

            // PRIORITY 2: Check if bot sent download link in text
            if (message.text) {
                const text = message.text;
                console.log('🔗 FileToLink bot response:', text);

                // Check if it's a join requirement message
                if (text.includes('join') && text.includes('@Ashlynn_Repository')) {
                    console.log('⚠️ Bot requires joining @Ashlynn_Repository channel');
                    for (let [key, resolve] of fileToLinkPendingUploads.entries()) {
                        resolve({
                            success: false,
                            error: 'Please join @Ashlynn_Repository channel first',
                            requiresJoin: true
                        });
                        fileToLinkPendingUploads.delete(key);
                        break;
                    }
                    return;
                }

                // Extract download link (usually starts with http or https)
                const linkMatch = text.match(/(https?:\/\/[^\s]+)/);
                if (linkMatch) {
                    const downloadLink = linkMatch[0];
                    console.log('✅ Download link received:', downloadLink);

                    // Resolve pending upload
                    for (let [key, resolve] of fileToLinkPendingUploads.entries()) {
                        resolve({ success: true, downloadLink: downloadLink, fullMessage: text });
                        fileToLinkPendingUploads.delete(key);
                        break;
                    }
                    return;
                }
            }
        }

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

        // Check if we're waiting for media (including TeraBox downloads)
        const waitingForMedia = pendingDownloads.size > 0 ||
            teraboxPendingDownloads.size > 0 ||
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

                // Mark and resolve (both regular and TeraBox)
                for (let [key] of pendingDownloads.entries()) {
                    receivedMediaTypes.set(key, 'image');
                }

                // Resolve regular downloads
                for (let [key, resolve] of pendingDownloads.entries()) {
                    resolve(downloadInfo);
                    pendingDownloads.delete(key);
                }

                // Resolve TeraBox downloads
                for (let [key, resolve] of teraboxPendingDownloads.entries()) {
                    resolve(downloadInfo);
                    teraboxPendingDownloads.delete(key);
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
                // Resolve all pending downloads with null
                for (let [key, resolve] of pendingDownloads.entries()) {
                    resolve(null);
                    pendingDownloads.delete(key);
                }
                for (let [key, resolve] of teraboxPendingDownloads.entries()) {
                    resolve(null);
                    teraboxPendingDownloads.delete(key);
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

            // Mark and resolve (both regular and TeraBox downloads)
            for (let [key] of pendingDownloads.entries()) {
                receivedMediaTypes.set(key, mediaType.toLowerCase());
            }

            // Resolve regular downloads
            for (let [key, resolve] of pendingDownloads.entries()) {
                resolve(downloadInfo);
                pendingDownloads.delete(key);
            }

            // Resolve TeraBox downloads (direct video scenario)
            for (let [key, resolve] of teraboxPendingDownloads.entries()) {
                resolve(downloadInfo);
                teraboxPendingDownloads.delete(key);
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

            // Resolve all pending downloads with null
            for (let [key, resolve] of pendingDownloads.entries()) {
                resolve(null);
                pendingDownloads.delete(key);
            }

            for (let [key, resolve] of teraboxPendingDownloads.entries()) {
                resolve(null);
                teraboxPendingDownloads.delete(key);
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

// FileToLink endpoint - Upload file to bot and get download link
app.post('/api/filetolink', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Check if Telegram is connected
    if (!client || !isConnected) {
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(503).json({ error: 'Telegram client not connected. Please wait...' });
    }

    try {
        console.log(`📤 Uploading file to @ARFileToLinkRoBot: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

        // Verify file exists
        if (!fs.existsSync(req.file.path)) {
            throw new Error('File not found after upload');
        }

        // Find FileToLink bot entity
        let bot;
        let retries = 3;
        while (retries > 0) {
            try {
                bot = await client.getEntity(fileToLinkBotUsername);
                break;
            } catch (error) {
                console.error(`Failed to get FileToLink bot entity, retries left: ${retries - 1}`);
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Read file as buffer
        const fileBuffer = fs.readFileSync(req.file.path);
        console.log(`📦 File read successfully: ${fileBuffer.length} bytes`);

        // Upload file to bot
        const uploadedFile = await client.uploadFile({
            file: fileBuffer,
            workers: 8
        });

        // Send file to bot with proper attributes
        await client.sendMessage(bot, {
            file: new Api.InputMediaUploadedDocument({
                file: uploadedFile,
                mimeType: req.file.mimetype || 'application/octet-stream',
                attributes: [
                    new Api.DocumentAttributeFilename({
                        fileName: req.file.originalname
                    })
                ]
            })
        });

        console.log(`✅ File uploaded to bot, waiting for download link...`);

        // Wait for bot response with download link
        const linkPromise = new Promise((resolve) => {
            const requestId = Date.now();
            fileToLinkPendingUploads.set(requestId, resolve);

            // Timeout after 60 seconds
            setTimeout(() => {
                if (fileToLinkPendingUploads.has(requestId)) {
                    fileToLinkPendingUploads.delete(requestId);
                    resolve(null);
                }
            }, 60000);
        });

        const result = await linkPromise;

        // Clean up uploaded file after sending to bot
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        if (result && result.success) {
            console.log(`🔗 Download link received: ${result.downloadLink}`);
            res.json({
                success: true,
                downloadLink: result.downloadLink,
                fileName: req.file.originalname,
                fileSize: req.file.size,
                message: result.fullMessage
            });
        } else if (result && result.requiresJoin) {
            // Bot requires joining channel
            res.status(403).json({
                success: false,
                error: result.error || 'Please join @Ashlynn_Repository channel first',
                requiresJoin: true,
                channelUrl: 'https://t.me/Ashlynn_Repository'
            });
        } else {
            res.status(408).json({ error: 'Timeout waiting for download link from bot' });
        }

    } catch (error) {
        console.error('Error in filetolink endpoint:', error);

        // Clean up file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ error: 'Failed to upload file: ' + error.message });
    }
});

// TeraBox endpoint - Handle both direct stream and Web App scenarios
app.post('/api/terabox', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // Check if Telegram is connected
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'Telegram client not connected. Please wait...' });
    }

    try {
        // Find TeraBox bot entity
        let bot;
        let retries = 3;
        while (retries > 0) {
            try {
                bot = await client.getEntity(teraboxBotUsername);
                break;
            } catch (error) {
                console.error(`Failed to get TeraBox bot entity, retries left: ${retries - 1}`);
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Send TeraBox URL to bot
        await client.sendMessage(bot, { message: url });
        console.log(`📤 Sent TeraBox URL to bot: ${url}`);

        // Wait for bot response (Web App URL or direct video)
        const teraboxPromise = new Promise((resolve) => {
            const requestId = Date.now();
            teraboxPendingDownloads.set(requestId, resolve);

            // Timeout after 60 seconds
            setTimeout(() => {
                if (teraboxPendingDownloads.has(requestId)) {
                    teraboxPendingDownloads.delete(requestId);
                    resolve(null);
                }
            }, 60000);
        });

        const result = await teraboxPromise;

        if (result) {
            if (result.type === 'webapp') {
                // Bot sent Web App URL
                console.log('🌐 TeraBox returned Web App URL');
                res.json({
                    success: true,
                    type: 'webapp',
                    webappUrl: result.url,
                    message: 'Open the Web App to stream video'
                });
            } else if (result.url) {
                // Bot sent direct video
                console.log('📹 TeraBox returned direct video');
                res.json({
                    success: true,
                    type: 'direct',
                    videoUrl: result.url,
                    fileName: result.fileName,
                    mediaType: result.mediaType || 'video'
                });
            } else {
                res.status(500).json({ error: 'Unexpected response from TeraBox bot' });
            }
        } else {
            res.status(408).json({ error: 'Timeout waiting for TeraBox bot response' });
        }

    } catch (error) {
        console.error('Error in TeraBox endpoint:', error);
        res.status(500).json({ error: 'Failed to process TeraBox link: ' + error.message });
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
