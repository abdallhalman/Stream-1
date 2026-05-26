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
const FPS    = 30;
const BUFFER_SIZE = 60; // 30fps × 2 ثانية - نكبرها لـ 120 لو FFmpeg جمع الـ fps

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

const videoPath  = path.join(__dirname, '../../video.mp4');
const audioPath  = path.join(__dirname, '../../merged_audio.mp3');
const framesDir  = path.join(__dirname, '../../frames');
const tmpPath    = path.join(__dirname, '../../overlay_tmp.png');

// ← إنشاء مجلد الفريمات
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

// ← تهيئة الـ buffer بأسماء ملفات ثابتة
for (let i = 0; i < BUFFER_SIZE; i++) {
    const p = path.join(framesDir, `frame_${String(i).padStart(3,'0')}.png`);
    if (!fs.existsSync(p)) {
        // صورة فارغة شفافة كـ placeholder
        fs.copyFileSync(path.join(__dirname, '../../overlay_tmp.png'), p);
    }
}

let writeIndex = 0; // Puppeteer يكتب هنا
let readIndex  = 0; // FFmpeg يقرأ من هنا (متأخر بـ BUFFER_SIZE)

function getFramePath(index) {
    return path.join(framesDir, `frame_${String(index % BUFFER_SIZE).padStart(3,'0')}.png`);
}

function startFFmpeg() {
    // FFmpeg يقرأ الفريمات من المجلد بالترتيب بشكل دائري
    const ffmpeg = spawn("ffmpeg", [
        "-re", "-framerate", `${FPS}`, "-f", "image2", 
        "-stream_loop", "-1", "-i", path.join(framesDir, "frame_%03d.png"),
        "-stream_loop", "-1", "-re", "-i", videoPath,
        "-stream_loop", "-1", "-re", "-i", audioPath,
        "-filter_complex", "[1:v][0:v]overlay=0:0[v]",
        "-map", "[v]",
        "-map", "2:a",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-r", `${FPS}`,
        "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "2500k",
        "-g", "50",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
        "-f", "flv",
        `rtmp://live.restream.io/live/${STREAM_KEY}`
    ]);
    ffmpeg.stderr.on("data", d => process.stderr.write(d));
    console.log("FFmpeg started.");
}

async function fillBuffer(page) {
    console.log(`Filling buffer: ${BUFFER_SIZE} frames...`);
    for (let i = 0; i < BUFFER_SIZE; i++) {
        const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
        fs.writeFileSync(tmpPath, screenshot);
        fs.renameSync(tmpPath, getFramePath(i));
    }
    writeIndex = BUFFER_SIZE;
    console.log("Buffer ready, starting FFmpeg...");
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

    // ← اكتب أول صورة للـ placeholder قبل أي شيء
    const first = await page.screenshot({ type: 'png', omitBackground: true });
    fs.writeFileSync(tmpPath, first);

    // ← املأ الـ buffer أولاً (2 ثانية)
    await fillBuffer(page);

    // ← الآن ابدأ FFmpeg
    startFFmpeg();

    // ← استمر في الكتابة بعد البدء
    setInterval(async () => {
        try {
            const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
            fs.writeFileSync(tmpPath, screenshot);
            fs.renameSync(tmpPath, getFramePath(writeIndex));
            writeIndex++;
        } catch (e) {
            console.error("Screenshot error:", e.message);
        }
    }, 1000 / FPS);
}

// ← محاولة الاتصال بتيك توك مع إعادة المحاولة كل 20 ثانية
const tiktok = new WebcastPushConnection(TIKTOK_USER);

function connectTikTok() {
    tiktok.connect()
        .then(() => {
            console.log("Connected TikTok to " + TIKTOK_USER);
            // ← نجح الاتصال: ابدأ Puppeteer
            startPuppeteer();
        })
        .catch(e => {
            console.error("TikTok connection failed:", e.message);
            console.log("Retrying in 20 seconds...");
            setTimeout(connectTikTok, 20000);
        });
}

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

// ← ابدأ هنا
connectTikTok();
