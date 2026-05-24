const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");

const TIKTOK_USER = "alhadath";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;

let totalLikes = 0;

const wss = new WebSocket.Server({ port: 8080 });
let wsClient = null;

wss.on("connection", (ws) => {
    wsClient = ws;
    console.log("Overlay interface connected local.");
});

function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        try {
            wsClient.send(JSON.stringify({ type, data }));
        } catch (e) {
            console.error("Error sending to overlay:", e);
        }
    }
}

const videoPath = path.join(__dirname, '../../video.mp4');
const audioPath = path.join(__dirname, '../../merged_audio.mp3');

const ffmpeg = spawn("ffmpeg", [
    "-f", "image2pipe",
    "-vcodec", "png",
    "-framerate", `${FPS}`,
    "-i", "pipe:0",
    "-stream_loop", "-1", "-re", "-i", videoPath,
    "-stream_loop", "-1", "-re", "-i", audioPath,
    "-filter_complex", "[1:v][0:v]overlay=0:0[v]",
    "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
    "-g", "60",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv",
    `rtmp://live.restream.io/live/${STREAM_KEY}`
]);

ffmpeg.stderr.on("data", d => process.stderr.write(d));

const tiktok = new WebcastPushConnection(TIKTOK_USER);

function connectToTikTok() {
    if (tiktok.connected) return;

    console.log("Attempting to connect to TikTok Live...");
    tiktok.connect()
        .then(() => {
            console.log("TikTok Connection Established Successfully!");
        })
        .catch(e => {
            console.error("TikTok Connection Failed. Retrying in 15 seconds...", e.message);
            setTimeout(connectToTikTok, 15000);
        });
}

tiktok.on("disconnected", () => {
    console.warn("TikTok disconnected! Reconnecting in 15 seconds...");
    setTimeout(connectToTikTok, 15000);
});

async function startPuppeteer() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    
    page.on('console', msg => console.log('HTML PAGE LOG:', msg.text()));

    const htmlPath = path.join(__dirname, 'overlay.html');
    await page.goto(`file://${htmlPath}`);

    setInterval(async () => {
        try {
            if (ffmpeg.stdin.writable) {
                const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
                ffmpeg.stdin.write(screenshot);
            }
        } catch (e) {}
    }, 1000 / FPS);

    console.log("Waiting 45 seconds for stream stability before connecting to TikTok...");
    setTimeout(connectToTikTok, 45000);
}

startPuppeteer();

// 1. Room Stats Only
tiktok.on("roomUser", data => { 
    if (data?.viewerCount !== undefined) {
        sendToOverlay("viewerCount", data.viewerCount); 
    }
});

// 2. Correct Join Event (member)
tiktok.on("member", data => {
    if (data?.uniqueId) {
        sendToOverlay("join", {
            name: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        });
    }
});

// 3. Like Event & Trigger Hearts
tiktok.on("like", data => { 
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes); 
        sendToOverlay("triggerHearts", data.likeCount);
    }
});

// 4. Correct Chat Event (Direct mapping)
tiktok.on("comment", data => {
    if (data?.comment) {
        const badgesArr = data.badges?.map(b => b.url || b.image?.url).filter(Boolean) || [];
        sendToOverlay("comment", {
            name: data.nickname || data.uniqueId,
            text: data.comment,
            avatar: data.profilePictureUrl,
            badges: badgesArr
        });
    }
});

// 5. Gift Event (Instant transmission)
tiktok.on("gift", data => {
    if (data?.giftName) {
        sendToOverlay("gift", {
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount || 1,
            avatar: data.profilePictureUrl
        });
    }
});
          
