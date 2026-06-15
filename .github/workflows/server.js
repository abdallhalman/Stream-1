const { TikTokLiveConnection } = require("tiktok-live-connector");  // ← تغيّر الاسم
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "chahr_2";
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

const videoPath    = path.join(__dirname, '../../video.mp4');
const audioPath    = path.join(__dirname, '../../merged_audio.mp3');
const tmpFramePath = path.join(__dirname, '../../overlay_tmp.png');
const mainFramePath = path.join(__dirname, '../../overlay.png');

if (fs.existsSync(tmpFramePath)) fs.unlinkSync(tmpFramePath);
if (fs.existsSync(mainFramePath)) fs.unlinkSync(mainFramePath);

const transparentBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAABLAAAAKAAQMAAAD9wU0FAAAABlBMVEUAAAD///+l2Z/dAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAALElEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAQMcOfAAB76v3ZwAAAABJRU5ErkJggg==",
    "base64"
);
fs.writeFileSync(mainFramePath, transparentBuffer);

async function startOverlayStream() {
    console.log("Starting Puppeteer Browser...");
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

    const htmlPath = path.join(__dirname, "overlay.html");
    await page.goto(`file://${htmlPath}`);
    console.log("Overlay page loaded in Puppeteer.");

    async function captureLoop() {
        try {
            await page.screenshot({ path: tmpFramePath, type: "png", omitBackground: true });
            if (fs.existsSync(tmpFramePath)) {
                fs.renameSync(tmpFramePath, mainFramePath);
            }
        } catch (err) {
            console.error("Error in capture loop:", err.message);
        }
        setTimeout(captureLoop, 1000 / 5);
    }

    captureLoop();

    console.log("Launching FFmpeg...");

    const ffmpegArgs = [
        "-re",
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

// ── TikTok Live Connector ──
let tiktok = new TikTokLiveConnection(TIKTOK_USER, {   // ← تغيّر الاسم
    signApiKey: process.env.EULER_API_KEY
});
// ── تشخيص ──
tiktok.fetchIsLive().then(isLive => {
    console.log("Is user live?", isLive);
}).catch(e => console.error("fetchIsLive error:", e.message));

tiktok.fetchRoomId().then(roomId => {
    console.log("Room ID:", roomId);
}).catch(e => console.error("fetchRoomId error:", e.message));


console.log("EULER_API_KEY:", process.env.EULER_API_KEY ? "loaded" : "NOT FOUND");
let tiktokRetries = 0;
const MAX_RETRIES = 5;

// ── الكومنت: user fields أصبحت داخل data.user ──
function handleComment(data) {
    const now = Date.now();
    if (now - lastCommentTime >= EVENT_THROTTLE_MS) {
        const text = data.comment || data.text || "";
        if (text) {
            sendToOverlay("comment", {
                name: data.user?.nickname || data.user?.uniqueId,       // ← تغيّر
                text: text.replace(/\[heart\]/g, "❤️"),
                avatar: data.user?.profilePictureUrl,                   // ← تغيّر
                badges: data.badges || []
            });
            lastCommentTime = now;
        }
    }
}

function connectTikTok() {
    if (tiktokRetries >= MAX_RETRIES) {
        console.error("TikTok: reached max retries, giving up.");
        return;
    }

    tiktokRetries++;
    console.log(`TikTok: connecting attempt ${tiktokRetries}...`);

    tiktok.connect()
        .then(() => {
            console.log("TikTok connected: " + TIKTOK_USER);
            tiktokRetries = 0;
        })
        .catch(e => {
            console.error(`TikTok failed (${tiktokRetries}/${MAX_RETRIES}):`, e.message);
            setTimeout(connectTikTok, 20000);
        });
}

tiktok.on("disconnected", () => {
    console.log("TikTok disconnected, retrying in 20s...");
    setTimeout(connectTikTok, 20000);
});

// ── roomUser: data.viewerCount لا يزال كما هو ──
tiktok.on("roomUser", data => {
    if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount);
});

// ── member: user fields أصبحت داخل data.user ──
tiktok.on("member", data => {
    const now = Date.now();
    if (now - lastJoinTime >= EVENT_THROTTLE_MS) {
        const name = data.user?.nickname || data.user?.uniqueId;        // ← تغيّر
        if (name) {
            sendToOverlay("join", {
                name: name,
                avatar: data.user?.profilePictureUrl                    // ← تغيّر
            });
            lastJoinTime = now;
        }
    }
});

// ── like: likeCount لا يزال كما هو ──
tiktok.on("like", data => {
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes);
    }
});

tiktok.on("comment", handleComment);
tiktok.on("chat", handleComment);

// ── follow: أصبح جزء من حدث social ──
tiktok.on("social", data => {
    const name = data.user?.nickname || data.user?.uniqueId;            // ← تغيّر
    if (name) {
        sendToOverlay("follow", {
            name: name,
            avatar: data.user?.profilePictureUrl,                       // ← تغيّر
            followerCount: data.followCount || 0
        });
    }
});

// ── gift: giftName أصبح داخل data.giftDetails ──
tiktok.on("gift", (data) => {
    if (data.repeatEnd || data.repeatCount === 1) {
        const giftIcon = data.giftDetails?.giftPictureUrl
            || data.image?.url_list?.[0]
            || "";

        sendToOverlay("gift", {
            name: data.user?.nickname || data.user?.uniqueId,           // ← تغيّر
            giftName: data.giftDetails?.giftName,                       // ← تغيّر
            count: data.repeatCount || 1,
            avatar: data.user?.profilePictureUrl,                       // ← تغيّر
            giftIcon: giftIcon
        });
    }
});

setTimeout(connectTikTok, 60000);
