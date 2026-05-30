const { WebcastPushConnection } = require("tiktok-live-connector");
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

// إنشاء سيرفر الـ WebSocket الثابت بشكل صحيح ونظيف
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

// ==================== [بداية نظام التشغيل الموحد والمطور لكسر البصمة] ====================
const videoPath   = path.join(__dirname, '../../video.mp4');
const audioPath   = path.join(__dirname, '../../merged_audio.mp3');
const tmpFramePath = path.join(__dirname, '../../overlay_tmp.png'); // الملف المؤقت المعزول للـ Puppeteer
const mainFramePath = path.join(__dirname, '../../overlay.png');     // الملف المستقر الذي يقرأه FFmpeg
const logoPath      = path.join(__dirname, 'logo.png');               // مسار اللوجو المباشر بجانب السكربت

// تنظيف وتصفير الصور القديمة من الـ Runner عند بدء التشغيل لمنع أي تعليق
if (fs.existsSync(tmpFramePath)) fs.unlinkSync(tmpFramePath);
if (fs.existsSync(mainFramePath)) fs.unlinkSync(mainFramePath);

// إنشاء فريم شفاف تماماً كبداية بأبعاد صحيحة حتى لا يتعطل FFmpeg عند الإقلاع
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
            await page.screenshot({ path: tmpFramePath, type: "png", omitBackground: true });
            if (fs.existsSync(tmpFramePath)) {
                fs.renameSync(tmpFramePath, mainFramePath);
            }
        } catch (err) {
            console.error("Error in capture loop:", err.message);
        }
        setTimeout(captureLoop, 1000 / FPS);
    }

    captureLoop();

    console.log("Launching FFmpeg with Strong Anti-Copyright Visual Filters...");

    // حساب قيم عشوائية محسّنة لكسر البصمة البصرية بشكل فعال في كل إقلاع للبث
    
    const randBrightness = (Math.random() * 0.06 - 0.03).toFixed(4);        // ±0.03 سطوع
    const randContrast   = (1 + (Math.random() * 0.06 - 0.03)).toFixed(4);  // ±0.03 تباين
    const randSaturation = (1 + (Math.random() * 0.08 - 0.04)).toFixed(4);  // ±0.04 تشبع لوني
    const randNoise      = (2 + Math.floor(Math.random() * 4));              // 2~5 نويز عشوائي
    const randHue        = (Math.random() * 4 - 2).toFixed(2);              // ±2 درجة هيو
    
    const ffmpegArgs = [
        "-re",
        "-loop", "1",
        "-f", "image2",
        "-i", mainFramePath,        // المدخل [0] الأوفرلاي الشفاف
        
        "-stream_loop", "-1",
        "-i", videoPath,            // المدخل [1] فيديو الخلفية الاساسي
        "-i", audioPath,            // المدخل [2] ملف الصوت
        
        "-loop", "1",
        "-i", logoPath,             // المدخل [3] صورة اللوجو الدائري المرفق
        
        "-filter_complex",
        // 1. معالجة فيديو الخلفية لكسر البصمة الرقمية البصرية
        `[1:v]fps=30,scale=${WIDTH}:${HEIGHT},` +
        `eq=brightness=${randBrightness}:contrast=${randContrast}:saturation=${randSaturation},` +
        `hue=h=${randHue},` +
        `noise=alls=${randNoise}:allf=t+p[bg_encoded];` +
        
        // 2. توليد موجة دائرية حقيقية 100% بنظام النيون الفيروزي المشع مع جعل خلفيتها شفافة بالكامل
        `[2:a]showwaves=s=450x450:mode=cline:rate=30:colors=0x00FFFF,` +
        `format=rgba,colorkey=0x000000:0.1:0.1[audio_circle];` +
        
        // 3. إجبار اللوجو الدائري على التصغير والحجم المناسب تماماً (250x250 بكسل) مع دعم الشفافية
        `[3:v]scale=250:250,format=rgba[logo_resized];` +
        
        // 4. دمج الهالة الدائرية الشفافة وتوسيطها بالكامل في منتصف الشاشة (x=415, y=135)
        `[bg_encoded][audio_circle]overlay=415:135:shortest=1[bg_with_circle];` +
        
        // 5. دمج اللوجو المصغر (250x250) في السنتر فوق الهالة الصوتية مباشرة (x=515, y=235)
        `[bg_with_circle][logo_resized]overlay=515:235[bg_with_logo];` +
        
        // 6. تهيئة طبقة شفافية التفاعل والتعليقات من المتصفح الافتراضي
        `[0:v]fps=30,scale=${WIDTH}:${HEIGHT}[overlay_v];` +
        
        // 7. إنتاج المشهد المجمع النهائي المستقر للبث
        `[bg_with_logo][overlay_v]overlay=0:0[out_v]`,
        
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

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stdout.on("data", (data) => console.log(`ffmpeg: ${data}`));
    ffmpegProcess.stderr.on("data", (data) => {
        if (data.toString().includes("Error") || data.toString().includes("frame=")) {
            console.log(`ffmpeg log: ${data.toString().trim()}`);
        }
    });

    ffmpegProcess.on("close", (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        browser.close();
        process.exit(code);
    });
}

startOverlayStream();
// ==================== [نهاية نظام التشغيل الجديد المطور] ====================

// ==================== [اتصال تيك توك والأحداث الأصلية كاملة ومطابقة 100%] ====================
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
