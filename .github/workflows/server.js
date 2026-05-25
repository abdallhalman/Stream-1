const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");

// الحساب المستهدف للبث
const TIKTOK_USER = "designer..fares..4k";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 25;

let totalLikes = 0;
let lastJoinTime = 0;
let lastCommentTime = 0;
const EVENT_THROTTLE_MS = 800; // تحسين وقت الاستجابة قليلاً

const wss = new WebSocket.Server({ port: 8080 });
let wsClient = null;

wss.on("connection", (ws) => {
    wsClient = ws;
    console.log("✅ Overlay interface connected local.");
});

function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type, data }));
    }
}

const videoPath = path.join(__dirname, '../../video.mp4');
const audioPath = path.join(__dirname, '../../merged_audio.mp3');

// إعدادات الـ FFmpeg الصارمة لقراءة الـ PNG بسرعة عالية جداً
const ffmpeg = spawn("ffmpeg", [
    "-f", "image2pipe",
    "-vcodec", "png",
    "-framerate", `${FPS}`,
    "-i", "pipe:0", 
    "-re", "-stream_loop", "-1", "-i", videoPath, 
    "-re", "-stream_loop", "-1", "-i", audioPath, 
    "-filter_complex", "[1:v][0:v]overlay=0:0:shortest=0[v]", 
    "-map", "[v]", 
    "-map", "2:a", 
    "-c:v", "libx264", 
    "-preset", "ultrafast", 
    "-tune", "zerolatency",  
    "-b:v", "2500k",        
    "-maxrate", "2500k", 
    "-bufsize", "5000k",    
    "-g", "50",
    "-c:a", "aac", 
    "-b:a", "128k", 
    "-ar", "44100",
    "-fflags", "+genpts",
    "-f", "flv",
    `rtmp://live.restream.io/live/${STREAM_KEY}`
]);

ffmpeg.stderr.on("data", d => process.stderr.write(d));

async function startPuppeteer() {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-gpu', 
            '--disable-dev-shm-usage', 
            `--window-size=${WIDTH},${HEIGHT}`
        ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    
    const htmlPath = path.join(__dirname, 'overlay.html');
    await page.goto(`file://${htmlPath}`);

    setInterval(async () => {
        try {
            if (ffmpeg.stdin.writable) {
                // التقاط سريع جداً مع تفعيل الخفة الفائقة للمتصفح لمنع التراكم الهبوطي لـ speed
                const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
                ffmpeg.stdin.write(screenshot);
            }
        } catch (e) {
            console.error("خطأ أثناء تمرير لقطة الشاشة للـ pipeline:", e.message);
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

// استقبال المتابعات بشكل منفصل تماماً لضمان تفعيل البنر
tiktok.on("follow", data => {
    if (data?.nickname || data?.uniqueId) {
        sendToOverlay("follow", {
            name: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        });
    }
});

function connectToTikTok() {
    console.log(`جاري الاتصال بحساب تيك توك: ${TIKTOK_USER}...`);
    tiktok.connect()
        .then(() => console.log("✅ تم الاتصال المباشر بالتيك توك"))
        .catch(e => {
            setTimeout(connectToTikTok, 15000);
        });
}

connectToTikTok();

tiktok.on('disconnected', () => {
    setTimeout(connectToTikTok, 5000);
});

setTimeout(startPuppeteer, 5000);
            
