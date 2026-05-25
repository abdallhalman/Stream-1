const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");

const TIKTOK_USER = "designer..fares..4k";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 10; // ← تقليل من 25 إلى 10: الأوفرلاي لا يحتاج أكثر

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

const ffmpeg = spawn("ffmpeg", [
    "-f", "image2pipe",
    "-vcodec", "mjpeg",      // ← JPEG بدل PNG: حجم أصغر بكثير (~50KB بدل ~500KB)
    "-framerate", `${FPS}`,
    "-i", "pipe:0",
    "-stream_loop", "-1", "-re", "-i", videoPath,
    "-stream_loop", "-1", "-re", "-i", audioPath,
    "-filter_complex", `[1:v][0:v]overlay=0:0[v]`,
    "-map", "[v]",
    "-map", "2:a",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",  // ← يقلل latency ويمنع تراكم buffer
    "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "2500k", // ← bufsize = maxrate (مش ضعفه)
    "-g", "50",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv",
    `rtmp://live.restream.io/live/${STREAM_KEY}`
]);

ffmpeg.stderr.on("data", d => process.stderr.write(d));

// ← المفتاح: backpressure - لا ترسل فريم جديد إلا لما FFmpeg جاهز
let isSending = false;

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
        // ← إذا FFmpeg stdin مليان (drain لم يُستدعى) تخطى الفريم هذا
        if (isSending) return;
        if (!ffmpeg.stdin.writable) return;

        try {
            isSending = true;
            const screenshot = await page.screenshot({ 
                type: 'jpeg',      // ← JPEG: أصغر وأسرع
                quality: 70        // ← جودة 70%: كافية للأوفرلاي
            });
            
            const canWrite = ffmpeg.stdin.write(screenshot);
            if (!canWrite) {
                // ← FFmpeg buffer ممتلئ: انتظر حتى يفرغ (drain event)
                await new Promise(resolve => ffmpeg.stdin.once('drain', resolve));
            }
        } catch (e) {
            console.error("Screenshot error:", e.message);
        } finally {
            isSending = false;
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

setTimeout(startPuppeteer, 5000);
                
