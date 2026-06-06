const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "sl42t";
const STREAM_KEY  = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;

const videoPath     = path.join(__dirname, '../../video.mp4');
const audioPath     = path.join(__dirname, '../../merged_audio.mp3');
const tmpFramePath  = path.join(__dirname, '../../overlay_tmp.png');
const mainFramePath = path.join(__dirname, '../../overlay.png');

// ── WebSocket للأوفرلاي ──
const wss = new WebSocket.Server({ port: 8080 });
let wsClient = null;

wss.on("connection", (ws) => {
    wsClient = ws;
    console.log("Overlay connected.");
});

function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type, data }));
    }
}

// ── تهيئة الفريم الشفاف الأولي ──
if (fs.existsSync(tmpFramePath))  fs.unlinkSync(tmpFramePath);
if (fs.existsSync(mainFramePath)) fs.unlinkSync(mainFramePath);

const { execSync } = require("child_process");
execSync(`ffmpeg -f lavfi -i color=c=black@0:size=${WIDTH}x${HEIGHT}:rate=1 -vframes 1 ${mainFramePath} -y 2>/dev/null`);
// ── Puppeteer + FFmpeg ──
async function startStream() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            `--window-size=${WIDTH},${HEIGHT}`,
            "--disable-gpu"
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(`file://${path.join(__dirname, "overlay.html")}`);
    console.log("Overlay loaded.");

    // حلقة التقاط بـ 10 FPS — كافية للإشعارات
    async function captureLoop() {
        try {
            await page.screenshot({ path: tmpFramePath, type: "png", omitBackground: true });
            if (fs.existsSync(tmpFramePath)) fs.renameSync(tmpFramePath, mainFramePath);
        } catch (err) {
            console.error("Capture error:", err.message);
        }
        setTimeout(captureLoop, 100); // 10 FPS
    }
    captureLoop();

    // ── FFmpeg — بدون فلاتر بصرية، كسر بصمة الصوت فقط ──
    const randNoise = (2 + Math.floor(Math.random() * 4)); // نويز بسيط على الفيديو فقط لكسر البصمة

    const ffmpegArgs = [
        "-re",
        "-loop", "1", "-f", "image2", "-r", "10", "-i", mainFramePath,

        "-stream_loop", "-1", "-i", videoPath,
        "-stream_loop", "-1","-i", audioPath,

        "-filter_complex",
        `[1:v]fps=30,scale=${WIDTH}:${HEIGHT},noise=alls=${randNoise}:allf=t[bg_v];` +
        `[0:v]fps=10[ov];` +
        `[bg_v][ov]overlay=0:0:shortest=1[out_v]`,

        "-map", "[out_v]",
        "-map", "2:a",
        "-c:v", "libx264",
        "-r", "30",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-f", "flv",
        `rtmp://live.restream.io/live/${STREAM_KEY}`
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stderr.on("data", (data) => {
    console.log(`ffmpeg: ${data.toString().trim()}`);
});

    ffmpeg.on("close", (code) => {
        console.log(`FFmpeg exited: ${code}`);
        browser.close();
        process.exit(code);
    });
}

startStream();

// ── TikTok — join فقط ──
const tiktok = new WebcastPushConnection(TIKTOK_USER);

let lastJoinTime = 0;
const JOIN_THROTTLE = 1500; // إشعار كل 1.5 ثانية كحد أقصى

function connectTikTok() {
    tiktok.connect()
        .then(() => console.log("TikTok connected: " + TIKTOK_USER))
        .catch(e => {
            console.error("TikTok error:", e.message, "— retry in 20s");
            setTimeout(connectTikTok, 20000);
        });
}

tiktok.on("disconnected", () => {
    console.log("TikTok disconnected — retry in 20s");
    setTimeout(connectTikTok, 20000);
});

tiktok.on("member", data => {
    const now = Date.now();
    if (now - lastJoinTime >= JOIN_THROTTLE && (data?.nickname || data?.uniqueId)) {
        sendToOverlay("join", {
            name:   data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        });
        lastJoinTime = now;
    }
});

setTimeout(connectTikTok, 120000);
