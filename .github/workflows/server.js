const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const renderer = require("./renderer.js");

const TIKTOK_USER = "sl42t";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;
const RENDER_FPS = 10; // معدل تحديث الأوفرلاي — مرتفع لأن canvas أخف بكثير من Puppeteer

let totalLikes = 0;
let lastJoinTime = 0;
let lastCommentTime = 0;
const EVENT_THROTTLE_MS = 1000;

// ==================== [نظام تشغيل الأوفرلاي بـ canvas + FFmpeg] ====================
const videoPath    = path.join(__dirname, '../../video.mp4');
const audioPath    = path.join(__dirname, '../../merged_audio.mp3');
const tmpFramePath  = path.join(__dirname, '../../overlay_tmp.png'); // الملف المؤقت المعزول
const mainFramePath = path.join(__dirname, '../../overlay.png');    // الملف المستقر الذي يقرأه FFmpeg

// تنظيف الصور القديمة من الـ Runner عند بدء التشغيل لمنع أي تعليق
if (fs.existsSync(tmpFramePath)) fs.unlinkSync(tmpFramePath);
if (fs.existsSync(mainFramePath)) fs.unlinkSync(mainFramePath);

// فريم أول فوري حتى لا يتعطل FFmpeg عند الإقلاع
try {
    fs.writeFileSync(mainFramePath, renderer.renderFrame());
} catch (e) {
    console.error("فشل توليد الفريم الأولي عبر canvas، استخدام فريم شفاف احتياطي:", e.message);
    const transparentBuffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAABLAAAAKAAQMAAAD9wU0FAAAABlBMVEUAAAD///+l2Z/dAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAALElEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAQMcOfAAB76v3ZwAAAABJRU5ErkJggg==",
        "base64"
    );
    fs.writeFileSync(mainFramePath, transparentBuffer);
}

// ── حلقة الرسم: محتواة بالكامل داخل try/catch ──
// أي خطأ في الرسم يُتجاهل فقط لتلك اللقطة، والفريم السابق الناجح يبقى كما هو
// في mainFramePath، فلا يتأثر FFmpeg ولا اتصال TikTok إطلاقاً.
const RENDER_WARN_MS = 40; // أي فريم رسم+كتابة يتجاوز هذا الوقت يُسجَّل مع تفاصيل اللحظة

function renderLoop() {
    const t0 = Date.now();
    try {
        const buffer = renderer.renderFrame();
        const t1 = Date.now();
        fs.writeFileSync(tmpFramePath, buffer);
        fs.renameSync(tmpFramePath, mainFramePath); // Atomic rename لمنع الـ flicker
        const t2 = Date.now();

        const renderMs = t1 - t0;
        const writeMs = t2 - t1;
        if (renderMs + writeMs > RENDER_WARN_MS) {
            const c = renderer.getDebugCounts();
            console.log(
                `[render] بطيء: رسم=${renderMs}ms كتابة=${writeMs}ms | ` +
                `فقاعات=${c.bubbles} انضمام=${c.joins} تعليقات=${c.comments} ` +
                `milestone=${c.milestone} هدية=${c.gift} متابعة=${c.follow} ` +
                `كاش_صور=${c.imageCacheSize}`
            );
        }
    } catch (err) {
        console.error("خطأ في حلقة الرسم (تم تجاهل الفريم، الفريم السابق باقي):", err.message);
    }
    setTimeout(renderLoop, 1000 / RENDER_FPS);
}
renderLoop();

// لوق دوري لمراقبة استهلاك الذاكرة وحجم كاش الصور بمرور وقت البث — يساعدنا نتحقق
// فعلياً (من نفس الجلسة) هل الذاكرة تتضخم مع الوقت، بدل ما نفترض بدون دليل مباشر.
// راقب: لو RSS يطلع بصعود مستمر بدون أي استقرار طول الساعات، وحجم الكاش يكبر معه،
// هذا يأكّد نظرية تسرّب الذاكرة. لو RSS يثبّت بعد فترة (الكاش وصل الحد الأقصى الجديد
// ٥٠٠ ووقف عن الزيادة)، يكون التحديد سليم ومافي تسرّب فعلي يهدد الجلسة.
const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000; // كل 5 دقايق
setInterval(() => {
    const mem = process.memoryUsage();
    const c = renderer.getDebugCounts();
    console.log(
        `[memory] RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB ` +
        `heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
        `كاش_صور=${c.imageCacheSize}`
    );
}, MEMORY_LOG_INTERVAL_MS);

// عداد إعادة التشغيل: نسمح بإعادة محاولات الانقطاع العابر (broken pipe / شبكة)
// بدون ما نوقف الجوب كامل، لكن لو تكرر الفشل بسرعة غير طبيعية (خلل حقيقي لا شبكة)
// نوقف نهائياً بدل تكرار لا نهائي يلخّم اللوق.
let ffmpegRestartCount = 0;
const FFMPEG_MAX_RESTARTS = 20;
let ffmpegLastStartAt = 0;

function startFFmpeg() {
    console.log("Launching FFmpeg...");
    ffmpegLastStartAt = Date.now();

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

        // لو كمّل أكثر من 5 دقايق قبل الانقطاع، نعتبره انقطاع عابر (شبكة/broken pipe)
        // ونصفّر عداد المحاولات المتتالية، فلا نوقف الجوب لمجرد كم انقطاع متباعد على مدى ساعات.
        if (Date.now() - ffmpegLastStartAt > 5 * 60 * 1000) {
            ffmpegRestartCount = 0;
        }

        ffmpegRestartCount++;
        if (ffmpegRestartCount > FFMPEG_MAX_RESTARTS) {
            console.error(
                `FFmpeg: ${FFMPEG_MAX_RESTARTS} محاولات متتالية فشلت بسرعة غير طبيعية — ` +
                `الأرجح خلل حقيقي (لا انقطاع شبكة عابر)، نوقف الجوب نهائياً.`
            );
            process.exit(code);
            return;
        }

        console.warn(
            `FFmpeg: انقطاع (الأرجح broken pipe/شبكة) — إعادة تشغيل تلقائي ` +
            `(محاولة ${ffmpegRestartCount}/${FFMPEG_MAX_RESTARTS}) بعد 3 ثواني... ` +
            `اتصال TikTok يبقى شغّال ولا يتأثر.`
        );
        setTimeout(startFFmpeg, 3000);
    });
}

startFFmpeg();
// ==================== [نهاية نظام البث] ====================

let tiktok = new WebcastPushConnection(TIKTOK_USER, {
    signApiKey: process.env.EULER_API_KEY
});
console.log("EULER_API_KEY:", process.env.EULER_API_KEY ? "loaded" : "NOT FOUND");
let tiktokRetries = 0;
const MAX_RETRIES = 5;

function handleComment(data) {
    const now = Date.now();
    if (now - lastCommentTime >= EVENT_THROTTLE_MS) {
        const text = data.comment || data.text || "";
        if (text) {
            renderer.addComment({
                name: data.nickname || data.uniqueId,
                text: text.replace(/\[heart\]/g, "❤️"),
                avatar: data.profilePictureUrl,
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

// بدون هذا المستمع: أي "error" event ترميه المكتبة بدون مستمع يكرش عملية Node كاملة
// (uncaught exception)، يعني ينقطع البث كامل من خطأ شبكة بسيط بمكتبة tiktok-live-connector.
tiktok.on("error", (e) => {
    console.error("TikTok connector error (تم تجاهله، البث يكمّل):", e?.message || e);
});

tiktok.on("roomUser", data => {
    if (data?.viewerCount !== undefined) renderer.setViewerCount(data.viewerCount);
});

tiktok.on("member", data => {
    const now = Date.now();
    if (now - lastJoinTime >= EVENT_THROTTLE_MS) {
        if (data?.nickname || data?.uniqueId) {
            renderer.addJoin({
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
        renderer.setLikes(totalLikes);
    }
});

tiktok.on("comment", handleComment);
tiktok.on("chat", handleComment);

tiktok.on("follow", data => {
    renderer.setFollow({
        name: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl,
        followerCount: data.followCount || 0
    });
});

tiktok.on("gift", (data) => {
    if (data.repeatEnd || data.repeatCount === 1) {
        let officialGiftIcon = data.giftPictureUrl
            || data.image?.url_list?.[0]
            || data.extendedGiftInfo?.image?.url_list?.[0]
            || "";

        renderer.setGift({
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount || 1,
            avatar: data.profilePictureUrl,
            giftIcon: officialGiftIcon
        });
    }
});

setTimeout(connectTikTok, 60000);
