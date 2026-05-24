const { TikTokConnectionWrapper } = require('tiktok-live-connector');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const TIKTOK_USERNAME = process.argv[2] || 'YOUR_TIKTOK_USERNAME'; 
const STREAM_KEY = process.argv[3] || 'YOUR_STREAM_KEY';
const RTMP_URL = `rtmp://live-api-s.restream.io/live/${STREAM_KEY}`;

const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;

const videoPath = path.join(__dirname, 'video.mp4');
const audioPath = path.join(__dirname, 'audio.mp3');

let wss;
let wsClient = null;
let ffmpegProcess = null;
let browser = null;
let page = null;

function startWebSocketServer() {
    wss = new WebSocket.Server({ port: 8080 });
    console.log('WebSocket Server running on port 8080');

    wss.on('connection', (ws) => {
        wsClient = ws;
        console.log('Overlay Browser Connected to WebSocket!');
    });
}

function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        try {
            wsClient.send(JSON.stringify({ type, data }));
        } catch (e) {
            console.error('Error sending data to overlay:', e);
        }
    }
}

function startFFmpeg() {
    const ffmpegArgs = [
        '-loglevel', 'info',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        '-r', `${FPS}`,
        '-i', '-',
        '-stream_loop', '-1', '-i', videoPath,
        '-stream_loop', '-1', '-i', audioPath,
        '-filter_complex', '[1:v][0:v]overlay=0:0:shortest=1[outv]',
        '-map', '[outv]',
        '-map', '2:a',
        '-vcodec', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-acodec', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-f', 'flv',
        RTMP_URL
    ];

    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcess.stdout.on('data', (data) => console.log(`[FFmpeg JSON] ${data}`));
    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('frame=')) {
            process.stdout.write(`\r${msg.trim().split('\n')[0]}`);
        } else {
            console.log(`[FFmpeg] ${msg.trim()}`);
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`\nFFmpeg exited with code ${code}. Exiting process.`);
        process.exit(1);
    });
}

async function startBrowser() {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            `--window-size=${WIDTH},${HEIGHT}`
        ]
    });

    page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });

    const htmlPath = path.join(__dirname, 'overlay.html');
    await page.goto(`file://${htmlPath}`);
    console.log('Overlay.html loaded in Headless Browser.');

    setInterval(async () => {
        try {
            if (ffmpegProcess && ffmpegProcess.stdin.writable) {
                const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
                ffmpegProcess.stdin.write(screenshot);
            }
        } catch (err) {
            // Ignore temporary lag errors
        }
    }, 1000 / FPS);
}

function connectTikTok() {
    const tiktokConnect = new TikTokConnectionWrapper(TIKTOK_USERNAME, {}, true);

    tiktokConnect.on('connected', () => {
        console.log(`\nTiktok Connection Established Successfully with @${TIKTOK_USERNAME}!`);
    });

    tiktokConnect.on('disconnected', () => {
        console.log('TikTok Connection Disconnected! Reconnecting...');
        setTimeout(connectTikTok, 5000);
    });

    tiktokConnect.on('chat', (data) => {
        if (data && data.comment) {
            sendToOverlay('comment', {
                nickname: data.nickname,
                uniqueId: data.uniqueId,
                comment: data.comment,
                profilePictureUrl: data.profilePictureUrl
            });
        }
    });

    tiktokConnect.on('member', (data) => {
        sendToOverlay('join', {
            nickname: data.nickname,
            uniqueId: data.uniqueId,
            profilePictureUrl: data.profilePictureUrl
        });
    });

    tiktokConnect.on('like', (data) => {
        sendToOverlay('like', {
            likeCount: data.likeCount,
            totalLikeCount: data.totalLikeCount,
            nickname: data.nickname
        });
    });

    tiktokConnect.on('roomUser', (data) => {
        sendToOverlay('viewerCount', {
            viewerCount: data.viewerCount
        });
    });

    tiktokConnect.connect().catch((err) => {
        console.error('Failed to connect to TikTok. Retrying...', err.message);
        setTimeout(connectTikTok, 10000);
    });
}

startWebSocketServer();
startFFmpeg();
startBrowser();
setTimeout(connectTikTok, 5000);
