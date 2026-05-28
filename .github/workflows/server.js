const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "alarabiya";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;

let totalLikes = 0;
let lastJoinTime = 0;
let lastCommentTime = 0;
const EVENT_THROTTLE_MS = 1000;

const wss = new WebS// ==================== [بداية نظام التشغيل الجديد] ====================
const videoPath   = path.join(__dirname, '../../video.mp4');
const audioPath   = path.join(__dirname, '../../merged_audio.mp3');
const tmpFramePath = path.join(__dirname, '../../overlay_tmp.png'); // الملف المؤقت المعزول للـ Puppeteer
const mainFramePath = path.join(__dirname, '../../overlay.png');     // الملف المستقر الذي يقرأه FFmpeg

// تنظيف وتصفير الصور القديمة من الـ Runner عند بدء التشغيل لمنع أي تعليق
if (fs.existsSync(tmpFramePath)) fs.unlinkSync(tmpFramePath);
if (fs.existsSync(mainFramePath)) fs.unlinkSync(mainFramePath);

// إنشاء فريم شفاف تماماً كبداية حتى لا يتعطل FFmpeg عند الإقلاع قبل المتصفح
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

    // ── حلقة التقاط الصور والـ Atomic Rename لمنع الـ Flicker ──
    async function captureLoop() {
        try {
            // 1. التقاط الشاشة وحفظها في الملف المؤقت المعزول عن الـ FFmpeg
            await page.screenshot({ path: tmpFramePath, type: "png", omitBackground: true });
            
            // 2. عملية الـ Rename السريعة جداً (تستبدل الملف الرئيسي فوراً في 0 ملي ثانية)
            if (fs.existsSync(tmpFramePath)) {
                fs.renameSync(tmpFramePath, mainFramePath);
            }
        } catch (err) {
            console.error("Error in capture loop:", err.message);
        }
        // الاستمرار في التقاط الفريم التالي بناءً على السرعة المتاحة للمتصفح
        setTimeout(captureLoop, 1000 / FPS);
    }

    // تشغيل حلقة الالتقاط
    captureLoop();

    // ── محرك الـ FFmpeg المطور لقراءة الملف الواحد المستقر ──
    console.log("Launching FFmpeg with Atomic Single-Frame Engine...");
    
    const ffmpegArgs = [
        "-loop", "1",               // تكرار قراءة الملف الثابت باستمرار
        "-f", "image2",
        "-re-file-loop", "1",       // إجبار الفلتر على إعادة فحص نظام الملفات وتحديث الصورة فوراً
        "-i", mainFramePath,        // مدخل الأوفرلاي الثابت
        
        "-stream_loop", "-1",       // تكرار فيديو الخلفية
        "-i", videoPath,
        
        "-i", audioPath,            // ملف الصوت المدمج
        
        "-filter_complex",
        `[0:v]fps=${FPS}[overlay_v];[1:v]fps=${FPS}[bg_v];[bg_v][overlay_v]overlay=0:0:shortest=1[out_v]`,
        
        "-map", "[out_v]",
        "-map", "2:a",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",     // لتقليل كاش المعالجة وضمان قراءة الفريم أولاً بأول
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
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

// تشغيل النظام الموحد الجديد
startOverlayStream();
// ==================== [نهاية نظام التشغيل الجديد] ====================
ocket.Server({ port: 8080 });
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

const videoPath   = path.join(__dirname, '../../video.mp4');


const tiktok = new WebcastPushConnection(TIKTOK_USER);

function connectTikTok() {
    tiktok.connect()
        .then(() => console.log("TikTok connected: " + TIKTOK_USER))
        .catch(e => {
            console.error("TikTok failed:", e.message, "- retrying in 20s...");
            setTimeout(connectTikTok, 20000);
        });
}

tiktok.on("disconnected", () => {
    console.log("TikTok disconnected, retrying in 20s...");
    setTimeout(connectTikTok, 20000);
});

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

function handleComment(data) {
    const now = Date.now();
    if (now - lastCommentTime >= EVENT_THROTTLE_MS) {
        const text = data.comment || data.text || "";
        if (text) {
            sendToOverlay("comment", {
                name: data.nickname || data.uniqueId,
                text: text.replace(/\[heart\]/g, "❤️"),
                avatar: data.profilePictureUrl,
                badges: data.badges || []
            });
            lastCommentTime = now;
        }
    }
}

tiktok.on("comment", handleComment);
tiktok.on("chat",    handleComment);

tiktok.on("follow", data => {
    sendToOverlay("follow", {
        name: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl,
        followerCount: data.followCount || 0
    });
});

tiktok.on("gift", (data) => {
    if (data.repeatEnd || data.repeatCount === 1) {
        let officialGiftIcon = "";
        if (data.giftPictureUrl) {
            officialGiftIcon = data.giftPictureUrl;
        } else if (data.image?.url_list?.[0]) {
            officialGiftIcon = data.image.url_list[0];
        } else if (data.extendedGiftInfo?.image?.url_list?.[0]) {
            officialGiftIcon = data.extendedGiftInfo.image.url_list[0];
        }

        sendToOverlay("gift", {
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount || 1,
            avatar: data.profilePictureUrl,
            giftIcon: officialGiftIcon
        });
    }
});

setTimeout(connectTikTok, 120000);
startPuppeteer();
