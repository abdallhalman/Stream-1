const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");

// تغيير الحساب إلى حساب إخباري مستمر للتجربة الفورية
const TIKTOK_USER = "alarabytv";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 25;

let totalLikes = 0;

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

// مسارات الفيديو والصوت الواحد المباشر لتسريع التجربة
const videoPath = path.join(__dirname, '../../video.mp4');
const audioPath = path.join(__dirname, '../../merged_audio.mp3');

const ffmpeg = spawn("ffmpeg", [
    "-f", "image2pipe",
    "-vcodec", "png",
    "-framerate", `${FPS}`,
    "-i", "pipe:0", // المدخل 0
    "-stream_loop", "-1", "-re", "-i", videoPath, // المدخل 1
    "-stream_loop", "-1", "-re", "-i", audioPath, // المدخل 2
    "-filter_complex", "[1:v][0:v]overlay=0:0[v]", // دمج الأوفرلاي فوق الفيديو
    "-map", "[v]", // تمرير الفيديو المدمج بنجاح
    "-map", "2:a", // ربط مسار صوت الملف الثاني (audioPath) بشكل مباشر وصحيح
    "-c:v", "libx264", 
    "-preset", "ultrafast", // تسريع المعالجة لأقصى حد لمنع هبوط الـ speed وحدوث الـ Broken pipe
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

// 1. حدث العدادات الإجمالية فقط (مصلح)
tiktok.on("roomUser", data => { 
    if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount); 
});

// 2. إحياء حدث الانضمام الشرعي والمستقل لسحب الأسماء فوراً
tiktok.on("member", data => {
    if (data?.nickname || data?.uniqueId) {
        sendToOverlay("join", {
            name: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        });
    }
});

// 3. حدث اللايكات المستقر
tiktok.on("like", data => { 
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes); 
    }
});

// 4. حدث التعليقات الآمن (يمرر البيانات الخام للمتصفح دون تعقيد البادجات هنا)
tiktok.on("comment", data => {
    sendToOverlay("comment", {
        name: data.nickname || data.uniqueId,
        text: data.comment,
        avatar: data.profilePictureUrl,
        badges: data.badges || []
    });
});

// 5. حدث الهدايا الشامل (لكل أنواع الهدايا)
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
