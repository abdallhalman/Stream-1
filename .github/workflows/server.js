// التعديل 1: استيراد الكلاس والحدث الجديدين
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "sl42t";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;

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

// ... [كود الـ Puppeteer والـ FFmpeg يظل كما هو دون تغيير] ...
const videoPath   = path.join(__dirname, '../../video.mp4');
const audioPath   = path.join(__dirname, '../../merged_audio.mp3');
const tmpFramePath = path.join(__dirname, '../../overlay_tmp.png');
const mainFramePath = path.join(__dirname, '../../overlay.png');

if (fs.existsSync(tmpFramePath)) fs.unlinkSync(tmpFramePath);
if (fs.existsSync(mainFramePath)) fs.unlinkSync(mainFramePath);

const transparentBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAABLAAAAKAAQMAAAD9wU0FAAAABlBMVEUAAAD///+l2Z/dAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAALElEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAQMcOfAAB76v3ZwAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(mainFramePath, transparentBuffer);

async function startOverlayStream() {
    console.log("Starting Puppeteer Browser...");
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${WIDTH},${HEIGHT}`, "--disable-gpu"] });
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(`file://${path.join(__dirname, "overlay.html")}`);
    
    async function captureLoop() {
        try {
            await page.screenshot({ path: tmpFramePath, type: "png", omitBackground: true });
            if (fs.existsSync(tmpFramePath)) fs.renameSync(tmpFramePath, mainFramePath);
        } catch (err) { console.error("Error in capture loop:", err.message); }
        setTimeout(captureLoop, 1000 / 5);
    }
    captureLoop();

    const ffmpegArgs = [
    "-re",                      // <--- لضبط سرعة القراءة
    "-loop", "1",
    "-f", "image2",
    "-i", mainFramePath,
    
    "-stream_loop", "-1",
    "-i", videoPath,
    "-stream_loop", "-1",
    "-i", audioPath,
    
     "-filter_complex",
     `[1:v]fps=30,scale=${WIDTH}:${HEIGHT}[bg_v];` +
     `[bg_v][0:v]overlay=0:0:shortest=1[out_v];` +
     `[1:a][2:a]amix=inputs=2:duration=longest[out_a]`,
     "-map", "[out_v]",
     "-map", "[out_a]",
     "-c:v", "libx264",
     "-r", "30",
     "-preset", "ultrafast",
     "-tune", "zerolatency",
     "-g", "60",
     "-keyint_min", "60",
     "-sc_threshold", "0",
     "-b:v", "2500k",
     "-maxrate", "2500k",
     "-bufsize", "5000k",
     "-b:a", "128k",
     "-pix_fmt", "yuv420p",
     "-c:a", "aac",
     "-b:a", "192k",
     "-f", "flv",
     `rtmp://live.restream.io/live/${STREAM_KEY}`
    ];


    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stdout.on("data", (data) => console.log(`ffmpeg: ${data}`));
    ffmpegProcess.stderr.on("data", (data) => {
        if (data.toString().includes("frame=")) {
            console.log(`ffmpeg status: ${data.toString().trim()}`);
        }
    });

    ffmpegProcess.on("close", (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        browser.close();
        process.exit(code);
    });
}
startOverlayStream();

// التعديل 2: تحديث تعريف الاتصال ليصبح connection واستخدام TikTokLiveConnection
const connection = new TikTokLiveConnection(TIKTOK_USER, {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    signApiKey: process.env.EULER_API_KEY
});

console.log("EULER_API_KEY:", process.env.EULER_API_KEY ? "loaded" : "NOT FOUND");
let tiktokRetries = 0;
const MAX_RETRIES = 5;

function handleComment(data) {
    const now = Date.now();
    if (now - lastCommentTime >= EVENT_THROTTLE_MS) {
        const text = data.comment || data.text || "";
        if (text) {
            sendToOverlay("comment", { name: data.nickname || data.uniqueId, text: text.replace(/\[heart\]/g, "❤️"), avatar: data.profilePictureUrl, badges: data.badges || [] });
            lastCommentTime = now;
        }
    }
}

function connectTikTok() {
    if (tiktokRetries >= MAX_RETRIES) return;
    tiktokRetries++;
    connection.connect().then(() => {
        console.log("TikTok connected: " + TIKTOK_USER);
        tiktokRetries = 0;
    }).catch(e => {
        console.error(`TikTok failed (${tiktokRetries}/${MAX_RETRIES}):`, e.message);
        setTimeout(connectTikTok, 20000);
    });
}

// التعديل 3: تحديث الأحداث لتستخدم WebcastEvent
connection.on("disconnected", () => { setTimeout(connectTikTok, 20000); });
connection.on("roomUser", data => { if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount); });
connection.on(WebcastEvent.MEMBER, data => { // ملاحظة: تم تحديث الحدث
    const now = Date.now();
    if (now - lastJoinTime >= EVENT_THROTTLE_MS) {
        if (data?.nickname || data?.uniqueId) {
            sendToOverlay("join", { name: data.nickname || data.uniqueId, avatar: data.profilePictureUrl });
            lastJoinTime = now;
        }
    }
});
connection.on(WebcastEvent.LIKE, data => { if (data.likeCount > 0) { totalLikes += Number(data.likeCount); sendToOverlay("like", totalLikes); }});
connection.on(WebcastEvent.CHAT, handleComment);
connection.on(WebcastEvent.FOLLOW, data => { sendToOverlay("follow", { name: data.nickname || data.uniqueId, avatar: data.profilePictureUrl, followerCount: data.followCount || 0 }); });
connection.on(WebcastEvent.GIFT, (data) => {
    if (data.repeatEnd || data.repeatCount === 1) {
        sendToOverlay("gift", { name: data.nickname || data.uniqueId, giftName: data.giftName, count: data.repeatCount || 1, avatar: data.profilePictureUrl, giftIcon: data.giftPictureUrl || "" });
    }
});

setTimeout(connectTikTok, 60000);
