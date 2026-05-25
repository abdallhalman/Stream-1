const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");

const TIKTOK_USER = "designer..fares..4k";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 25;

let totalLikes = 0;
let lastJoinTime = 0;
let lastCommentTime = 0;
let lastFollowTime = 0;
const EVENT_THROTTLE_MS = 1000; // منع التكدس

const wss = new WebSocket.Server({ port: 8080 });
let wsClient = null;

wss.on("connection", (ws) => {
    wsClient = ws;
    console.log("Overlay interface connected local.");
});

function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type, data }));
    }
}

const videoPath = path.join(__dirname, '../../video.mp4');
const audioPath = path.join(__dirname, '../../merged_audio.mp3');

const ffmpeg = spawn("ffmpeg", [
    "-f", "image2pipe",
    "-vcodec", "png",
    "-framerate", `${FPS}`,
    "-i", "pipe:0", 
    "-stream_loop", "-1", "-re", "-i", videoPath, 
    "-stream_loop", "-1", "-re", "-i", audioPath, 
    "-filter_complex", "[1:v][0:v]overlay=0:0[v]", 
    "-map", "[v]", 
    "-map", "2:a", 
    "-c:v", "libx264", 
    "-preset", "ultrafast", 
    "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
    "-g", "60",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv",
    `rtmp://live.restream.io/live/${STREAM_KEY}`
]);

ffmpeg.stderr.on("data", d => process.stderr.write(d));

async function startPuppeteer() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    
    const htmlPath = path.join(__dirname, 'overlay.html');
    await page.goto(`file://${htmlPath}`);

    setInterval(async () => {
        try {
            const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
            if (ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(screenshot);
            }
        } catch (e) {}
    }, 1000 / FPS);
}

const tiktok = new WebcastPushConnection(TIKTOK_USER);

// العدادات الإجمالية
tiktok.on("roomUser", data => { 
    if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount); 
});

// إشعار انضمام الغرفة
tiktok.on("member", data => {
    const now = Date.now();
    if (now - lastJoinTime >= EVENT_THROTTLE_MS) {
        if (data?.nickname || data?.uniqueId) {
            sendToOverlay("join", {
                name: data.nickname || data.uniqueId,
                avatar: data.profilePictureUrl
            });
            lastJoinTime = now;
        }
    }
});

// إشعار المتابعين الجدد (تمت إضافته وإصلاحه)
tiktok.on("follow", data => {
    const now = Date.now();
    if (now - lastFollowTime >= EVENT_THROTTLE_MS) {
        if (data?.nickname || data?.uniqueId) {
            sendToOverlay("follow", {
                name: data.nickname || data.uniqueId,
                avatar: data.profilePictureUrl
            });
            lastFollowTime = now;
        }
    }
});

// الإعجابات
tiktok.on("like", data => { 
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes); 
    }
});

// التعليقات
tiktok.on("comment", data => {
    const now = Date.now();
    if (now - lastCommentTime >= EVENT_THROTTLE_MS) {
        sendToOverlay("comment", {
            name: data.nickname || data.uniqueId,
            text: data.comment,
            avatar: data.profilePictureUrl,
            badges: data.badges || []
        });
        lastCommentTime = now;
    }
});

// الهدايا
tiktok.on("gift", data => {
    if (data.repeatEnd || data.repeatCount === 1) {
        sendToOverlay("gift", {
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount || 1,
            avatar: data.profilePictureUrl
        });
    }
});

function connectToTikTok() {
    console.log(`Attempting to connect to TikTok user: ${TIKTOK_USER}...`);
    
    tiktok.connect()
        .then(() => {
            console.log("✅ TikTok connection established successfully!");
        })
        .catch(e => {
            console.error("❌ Connection failed (Stream might be offline or rate-limited).");
            console.log("🔄 Retrying connection in 15 seconds...");
            setTimeout(connectToTikTok, 15000);
        });
}

connectToTikTok();

tiktok.on('disconnected', () => {
    console.log("⚠️ TikTok connection lost unexpectedly!");
    console.log("🔄 Initializing auto-reconnect in 5 seconds...");
    setTimeout(connectToTikTok, 5000);
});

setTimeout(startPuppeteer, 5000);
        
