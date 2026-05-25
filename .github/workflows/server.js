const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "designer..fares..4k";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 10;

let totalLikes = 0;
let lastJoinTime = 0;
let lastCommentTime = 0;
const EVENT_THROTTLE_MS = 1000;

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
const overlayPath = path.join(__dirname, '../../overlay.png');

// ← FFmpeg يبدأ فقط بعد استدعاء هذه الدالة
function startFFmpeg() {
    const ffmpeg = spawn("ffmpeg", [
        "-re", "-stream_loop", "-1", "-i", overlayPath,
        "-stream_loop", "-1", "-re", "-i", videoPath,
        "-stream_loop", "-1", "-re", "-i", audioPath,
        "-filter_complex", "[1:v][0:v]overlay=0:0[v]",
        "-map", "[v]",
        "-map", "2:a",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "2500k",
        "-g", "50",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
        "-f", "flv",
        `rtmp://live.restream.io/live/${STREAM_KEY}`
    ]);
    ffmpeg.stderr.on("data", d => process.stderr.write(d));
    console.log("FFmpeg started.");
}

async function startPuppeteer() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });

    const htmlPath = path.join(__dirname, 'overlay.html');
    await page.goto(`file://${htmlPath}`);

    // ← أول صورة تُكتب على الديسك أولاً
    const first = await page.screenshot({ type: 'png', omitBackground: true });
    fs.writeFileSync(overlayPath, first);
    console.log("overlay.png written, starting FFmpeg...");

    // ← الآن فقط يبدأ FFmpeg بعد ما الملف موجود
    startFFmpeg();

    // ← تحديث الأوفرلاي كل ثانية
    setInterval(async () => {
        try {
            const screenshot = await page.screenshot({
                type: 'png',
                omitBackground: true
            });
            fs.writeFileSync(overlayPath, screenshot);
        } catch (e) {
            console.error("Screenshot error:", e.message);
        }
    }, 1000 / FPS);
}

const tiktok = new WebcastPushConnection(TIKTOK_USER);

tiktok.on("roomUser", data => {
    if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount);
});

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

tiktok.on("like", data => {
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes);
    }
});

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

tiktok.connect().then(() => console.log("Connected TikTok to " + TIKTOK_USER)).catch(e => console.error(e));

startPuppeteer();
