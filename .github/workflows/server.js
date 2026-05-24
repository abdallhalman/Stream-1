const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");

const TIKTOK_USER = "livequranchannel";
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
        wsClient.send(JSON.stringify({ type, data }));
    }
}

const ffmpeg = spawn("ffmpeg", [
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${WIDTH}x${HEIGHT}`,
    "-framerate", `${FPS}`,
    "-i", "pipe:0",
    "-stream_loop", "-1", "-re", "-i", "video.mp4",
    "-stream_loop", "-1", "-re", "-i", "merged_audio.mp3",
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
            const screenshot = await page.screenshot({ type: 'raw' });
            if (ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(screenshot);
            }
        } catch (e) {}
    }, 1000 / FPS);
}

const tiktok = new WebcastPushConnection(TIKTOK_USER);

tiktok.on("roomUser", data => { 
    if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount); 
    if (data?.nickname || data?.uniqueId) {
        sendToOverlay("join", {
            name: data.nickname || data.uniqueId,
            avatar: data.profilePictureUrl
        });
    }
});

tiktok.on("like", data => { 
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes); 
    }
});

tiktok.on("comment", data => {
    sendToOverlay("comment", {
        name: data.nickname || data.uniqueId,
        text: data.comment,
        avatar: data.profilePictureUrl,
        badges: data.badges?.map(b => b.url || b.image?.url).filter(Boolean) || []
    });
});

tiktok.on("gift", data => {
    if (data.repeatEnd) {
        sendToOverlay("gift", {
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount,
            avatar: data.profilePictureUrl
        });
    }
});

tiktok.connect().then(() => console.log("Connected TikTok")).catch(e => console.error(e));

setTimeout(startPuppeteer, 15000);
