// ==================== renderer.js ====================
// محرك رسم الأوفرلاي بالكامل عبر @napi-rs/canvas بدل Puppeteer/Chromium + overlay.html.
// مفصول كملف مستقل عمداً: أي خطأ هنا يبقى محتوى داخل try/catch في حلقة الرسم
// في server.js، فلا يوقف اتصال TikTok ولا عملية FFmpeg أبداً.
// ======================================================

const path = require("path");
const fs = require("fs");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

const WIDTH = 1280;
const HEIGHT = 720;

// ──────────────────────────────────────────────
// 1. تسجيل الخطوط
// ──────────────────────────────────────────────
// يحمّل خطوط النظام المثبتة عبر apt (Noto Sans / Noto Sans Arabic / Noto Color Emoji)
GlobalFonts.loadSystemFonts();

// Almarai ليس خط نظام (كان يتحمّل من Google Fonts داخل المتصفح فقط).
// تم تنزيله في خطوة الـ workflow إلى مجلد fonts/ بجانب هذا الملف وتسجيله هنا يدوياً.
const FONTS_DIR = path.join(__dirname, "fonts");
const customFonts = [
    ["Almarai-Regular.ttf", "Almarai"],
    ["Almarai-Bold.ttf", "Almarai Bold"],
    ["Almarai-ExtraBold.ttf", "Almarai ExtraBold"],
];
for (const [file, alias] of customFonts) {
    const fp = path.join(FONTS_DIR, file);
    if (fs.existsSync(fp)) {
        try {
            GlobalFonts.registerFromPath(fp, alias);
        } catch (e) {
            console.error(`[renderer] فشل تسجيل الخط ${file}:`, e.message);
        }
    } else {
        console.warn(`[renderer] الخط غير موجود: ${fp} — سيُستخدم Noto Sans كبديل مؤقت`);
    }
}

const FONT_TEXT  = `"Almarai", "Noto Sans Arabic", "Noto Sans", "Noto Color Emoji", sans-serif`;
const FONT_BOLD  = `"Almarai Bold", "Almarai", "Noto Sans Arabic", "Noto Sans", "Noto Color Emoji", sans-serif`;
const FONT_XBOLD = `"Almarai ExtraBold", "Almarai Bold", "Almarai", "Noto Sans Arabic", "Noto Color Emoji", sans-serif`;

// ──────────────────────────────────────────────
// 2. الكانفاس الرئيسي (يُعاد استخدامه لكل فريم، بدون إعادة إنشاء)
// ──────────────────────────────────────────────
const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext("2d");

// ──────────────────────────────────────────────
// 3. كاش الصور (avatars / أيقونات الهدايا / اللوقو)
// ──────────────────────────────────────────────
const imageCache = new Map(); // url -> Image | "loading" | "failed"
const FALLBACK_AVATAR = "https://www.tiktok.com/favicon.ico";

function getImage(url) {
    if (!url) return null;
    const cached = imageCache.get(url);
    if (cached && cached !== "loading" && cached !== "failed") return cached;
    if (cached === "loading" || cached === "failed") return null;

    imageCache.set(url, "loading");
    loadImage(url)
        .then((img) => imageCache.set(url, img))
        .catch(() => imageCache.set(url, "failed")); // فشل التحميل = دائرة بديلة بدون توقف
    return null;
}

// اللوقو يتحمّل مرة واحدة عند الإقلاع، بجانب server.js مثل السابق
let logoImg = null;
const logoPath = path.join(__dirname, "logo.png");
if (fs.existsSync(logoPath)) {
    loadImage(logoPath)
        .then((img) => (logoImg = img))
        .catch((e) => console.warn("[renderer] فشل تحميل اللوقو:", e.message));
} else {
    console.warn("[renderer] logo.png غير موجود بجانب renderer.js — سيُتجاهل اللوقو");
}

// ──────────────────────────────────────────────
// 4. الحالة الداخلية — نفس منطق overlay.html تماماً
// ──────────────────────────────────────────────
const STEP_TARGET = 1000;
const AZKAR_LIST = [
    { main: "سبحان الله",      sub: "🌿سبحان الله وبحمده، سبحان الله العظيم" },
    { main: "الحمد لله",       sub: "🤍الحمد لله حمدا كثيرا طيبا مباركا فيه" },
    { main: "لا إله إلا الله", sub: "🤲لا إله إلا الله وحده لا شريك له"      },
    { main: "الله أكبر",       sub: "☝️الله أكبر كبيرا، والحمد لله كثيرا"    },
    { main: "أستغفر الله",     sub: "🕋أستغفر الله العظيم وأتوب إليه"         },
];

const NOTIF_MAX        = 9; // عدد الكروت المحفوظة بالذاكرة لكل قائمة (يكفي لتعبئة حاوية التعليقات الأطول)
const GIFT_HIDE_MS     = 7000;
const FOLLOW_HIDE_MS   = 7000;
const MILESTONE_MS     = 10000;
const BUBBLE_HOLD_MS   = 2000;
const BUBBLE_FADE_MS   = 400;

const state = {
    viewerCount: 0,
    totalLikes: 0,

    lastTriggeredStage: -1,
    isMilestoneActive: false,
    milestoneShownAt: 0,
    milestoneText: "",
    currentAzkarItem: AZKAR_LIST[0],

    bubbleText: "",
    bubbleShownAt: 0,
    bubblePalette: null,

    tasbihPercentage: 0,
    tasbihNumbersText: `0 / ${STEP_TARGET.toLocaleString()}`,
    tasbihBumpAt: 0,

    gift: null,
    giftHideAt: 0,

    follow: null,
    followHideAt: 0,

    joinNotifications: [],    // [0]=الأحدث — جهة اليسار
    commentNotifications: [], // [0]=الأحدث — جهة اليمين
};

const COLOR_PALETTE = [
    "rgba(57,255,20,0.75)",
    "rgba(0,200,255,0.75)",
    "rgba(255,188,0,0.75)",
    "rgba(255,60,200,0.75)",
    "rgba(157,93,255,0.75)",
    "rgba(255,100,50,0.75)",
];
function randomColor() {
    return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

const BUBBLE_PALETTES = [
    { bg: "rgba(57,255,20,0.12)",  border: "rgba(57,255,20,0.6)"  },
    { bg: "rgba(0,200,255,0.12)",  border: "rgba(0,200,255,0.6)"  },
    { bg: "rgba(255,188,0,0.12)",  border: "rgba(255,188,0,0.6)"  },
    { bg: "rgba(255,60,200,0.12)", border: "rgba(255,60,200,0.6)" },
    { bg: "rgba(157,93,255,0.12)", border: "rgba(157,93,255,0.6)" },
    { bg: "rgba(255,100,50,0.12)", border: "rgba(255,100,50,0.6)" },
];

// ──────────────────────────────────────────────
// 5. دوال تحديث الحالة — تُستدعى مباشرة من server.js بدل WebSocket
// ──────────────────────────────────────────────
function setViewerCount(count) {
    state.viewerCount = count;
}

function showBubble(text) {
    state.bubbleText = text;
    state.bubbleShownAt = Date.now();
    state.bubblePalette = BUBBLE_PALETTES[Math.floor(Math.random() * BUBBLE_PALETTES.length)];
}

function setLikes(total) {
    state.totalLikes = total;

    const stage = Math.floor(total / STEP_TARGET);
    const currentLikes = total % STEP_TARGET;
    const currentItem = AZKAR_LIST[stage % AZKAR_LIST.length];

    // اكتمال مرحلة جديدة (نفس منطق > بدل === في الأصل)
    if (stage > state.lastTriggeredStage && !state.isMilestoneActive) {
        state.lastTriggeredStage = stage;
        state.isMilestoneActive = true;
        state.milestoneShownAt = Date.now();
        state.milestoneText = `:الذكر التالي ${currentItem.main}`;
        state.tasbihPercentage = 100;

        setTimeout(() => {
            state.isMilestoneActive = false;
            state.tasbihPercentage = 0;
            state.tasbihNumbersText = `0 / ${STEP_TARGET.toLocaleString()}`;
            state.currentAzkarItem = currentItem;
        }, MILESTONE_MS);
        return;
    }

    if (!state.isMilestoneActive) {
        state.tasbihPercentage = (currentLikes / STEP_TARGET) * 100;
        state.tasbihNumbersText = `${currentLikes.toLocaleString()} / ${STEP_TARGET.toLocaleString()}`;
        state.tasbihBumpAt = Date.now();
        state.currentAzkarItem = currentItem;
        showBubble(currentItem.main);
    }
}

function pushNotification(list, kind, name, action, avatar) {
    list.unshift({
        kind,
        name: name || (kind === "join" ? "متابع جديد" : "متابع"),
        action: action || "",
        avatar: avatar || FALLBACK_AVATAR,
        color: randomColor(),
        createdAt: Date.now(),
    });
    if (list.length > NOTIF_MAX) list.length = NOTIF_MAX;
}

function addJoin({ name, avatar }) {
    pushNotification(state.joinNotifications, "join", name, "✨انضم الآن", avatar);
}

function addComment({ name, text, avatar }) {
    pushNotification(state.commentNotifications, "comment", name, text, avatar);
}

function setFollow({ name, avatar, followerCount }) {
    state.follow = {
        name: name || "متابع جديد",
        avatar: avatar || FALLBACK_AVATAR,
        count: followerCount ? Number(followerCount).toLocaleString() : "0",
    };
    state.followHideAt = Date.now() + FOLLOW_HIDE_MS;
}

function setGift({ name, giftName, count, avatar, giftIcon }) {
    const safeName = name || "داعم كريم";
    const isSame = state.gift && state.gift.name === safeName && state.gift.giftName === giftName;

    if (isSame) {
        state.gift.count += count || 1;
        state.gift.lastBumpAt = Date.now();
    } else {
        state.gift = {
            name: safeName,
            giftName,
            count: count || 1,
            avatar: avatar || FALLBACK_AVATAR,
            giftIcon: giftIcon || "",
            shownAt: Date.now(),
            lastBumpAt: Date.now(),
        };
    }
    state.giftHideAt = Date.now() + GIFT_HIDE_MS;
}

// ──────────────────────────────────────────────
// 6. أدوات رسم مساعدة
// ──────────────────────────────────────────────
function roundRect(x, y, w, h, r) {
    // المتصفح (CSS) يحدّ border-radius تلقائياً عند نصف عرض/ارتفاع الصندوق،
    // لكن canvas ما يسوي هذا تلقائياً — لو تجاهلناها تطلع زوايا حادة/شكل "كماشة" بدل بيضاوي ناعم.
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawCircleImage(img, cx, cy, radius, borderColor, borderWidth = 2) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
        ctx.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
    } else {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fill();
    }
    ctx.restore();

    if (borderColor) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = borderWidth;
        ctx.stroke();
    }
}

function truncateText(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = String(text);
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) {
        t = t.slice(0, -1);
    }
    return t + "…";
}

// ──────────────────────────────────────────────
// 7. الرسم — كل عنصر بدالته الخاصة، بترتيب z-index الأصلي (من الخلف للأمام)
// ──────────────────────────────────────────────

// يحاكي بالضبط linear-gradient(to top, ...) الأصلي في #join-container:
// 0%→معتم بالكامل، 15%→0.95، 50%→0.7، 80%→0.2، 100%→شفاف تماماً
// دالة عامة تحاكي linear-gradient(to top, ...) بأي نقاط توقف تُمرَّر لها
function maskAlpha(distanceFromBottom, containerHeight, stops) {
    const f = distanceFromBottom / containerHeight; // 0 = عند القاعدة، 1 = عند أعلى الحاوية
    if (f <= 0) return 1;
    if (f >= 1) return 0;
    for (let i = 0; i < stops.length - 1; i++) {
        const [f0, a0] = stops[i];
        const [f1, a1] = stops[i + 1];
        if (f >= f0 && f <= f1) {
            const t = (f - f0) / (f1 - f0);
            return a0 + (a1 - a0) * t;
        }
    }
    return 0;
}

// نفس نقاط mask-image لـ #join-container الأصلي
const JOIN_MASK_STOPS = [
    [0, 1], [0.1, 1], [0.2, 1], [0.3, 1], [0.4, 1], [0.5, 1], 
    [0.6, 1], [0.7, 1], [0.8, 0.6], [0.9, 0.3], [1, 0],
];
// نفس نقاط mask-image لـ #chat-container الأصلي (11 نقطة، تدرّج أنعم على ارتفاع أكبر)
const COMMENT_MASK_STOPS = [
    [0, 1], [0.1, 1], [0.2, 1], [0.3, 1], [0.4, 1], [0.5, 1], 
    [0.6, 1], [0.7, 1], [0.8, 0.6], [0.9, 0.3], [1, 0],
];


function drawNotificationStack(list, x) {
    const boxW = 360;
    const cardH = 54;
    const stepY = 65; // متقارب أكثر من السابق — يسمح بعدد أكبر من الكروت يملأ المساحة للأعلى
    const containerHeight = 550; // نفس ارتفاع #join-container الأصلي
    const bottomY = HEIGHT - 40;

    // [0] = الأحدث ويظهر بالأسفل (أقرب للحافة)، الأقدم يرتفع للأعلى ويتلاشى تدريجياً
    list.forEach((item, idx) => {
        const cardBottom = bottomY - idx * stepY;
        const y = cardBottom - cardH;
        const distanceFromBottom = idx * stepY;
        const alpha = maskAlpha(distanceFromBottom, containerHeight, JOIN_MASK_STOPS);
        if (alpha <= 0.05) return; // تلاشى تماماً، لا داعي لرسمه

        ctx.save();
        ctx.globalAlpha = alpha;

        ctx.fillStyle = "rgba(20,20,30,0.60)";
        roundRect(x, y, boxW, cardH, 18);
        ctx.fill();
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = item.color;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        const avatarR = 20;
        const avatarCx = x + 18 + avatarR;
        const avatarCy = y + cardH / 2;
        drawCircleImage(getImage(item.avatar), avatarCx, avatarCy, avatarR, "rgba(255,255,255,0.4)", 1);

        const textX = avatarCx + avatarR + 16;
        const maxTextW = boxW - (textX - x) - 16;
        ctx.textAlign = "left";
        ctx.fillStyle = item.kind === "comment" ? "#ffbc00" : "#ffffff";
        ctx.font = `600 18px ${FONT_BOLD}`;
        ctx.fillText(truncateText(item.name, maxTextW), textX, avatarCy - 4);

        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = `600 13px ${FONT_TEXT}`;
        ctx.fillText(truncateText(item.action, maxTextW), textX, avatarCy + 16);

        ctx.restore();
    });
}

function drawJoinNotifications() {
    drawNotificationStack(state.joinNotifications, 30); // يسار الشاشة
}

// ── نظام التعليقات الأساسي: كروت مرنة تتمدد للأسفل حسب طول النص ──

// يقيس عرض نص بخط معيّن (مع ضبط ctx.font أولاً)
function measureWith(text, font) {
    ctx.font = font;
    return ctx.measureText(text).width;
}

// يقسّم مجموعة "tokens" (كل واحد بخطه ولونه) إلى كلمات، ويلفّها على عدة أسطر
// حسب maxWidth، تماماً كما يفعل المتصفح مع username + text inline.
function layoutInlineTokens(tokens, maxWidth) {
    const words = [];
    tokens.forEach((tok) => {
        String(tok.text).split(" ").forEach((w) => {
            if (w.length) words.push({ text: w, font: tok.font, color: tok.color });
        });
    });

    const lines = [];
    let currentLine = [];
    let currentWidth = 0;

    words.forEach((word) => {
        const wWidth = measureWith(word.text, word.font);
        const spaceWidth = currentLine.length ? measureWith(" ", word.font) : 0;
        const projected = currentWidth + spaceWidth + wWidth;
        if (projected > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = [word];
            currentWidth = wWidth;
        } else {
            currentLine.push(word);
            currentWidth = projected;
        }
    });
    if (currentLine.length) lines.push(currentLine);
    return lines;
}

function drawInlineLines(lines, x, startY, lineHeight) {
    let cy = startY;
    lines.forEach((line) => {
        let cx = x;
        ctx.textAlign = "left";
        line.forEach((word) => {
            ctx.font = word.font;
            ctx.fillStyle = word.color;
            ctx.fillText(word.text, cx, cy);
            cx += measureWith(word.text, word.font) + measureWith(" ", word.font);
        });
        cy += lineHeight;
    });
}

function drawCommentNotifications() {
    const boxW = 380;            // نفس عرض #chat-container الأصلي
    const containerHeight = 550; // نفس ارتفاع #chat-container الأصلي
    const padX = 18, padY = 9;   // نفس padding: 6px 12px الأصلي
    const avatarR = 17, avatarD = avatarR * 2;
    const gapAvatarText = 12;
    const lineHeight = 24;       // يقارب line-height:1.4 على خط 18px
    const marginTop = 8;         // المسافة بين كرت وكرت (margin-top:8px الأصلي)
    const bottomY = HEIGHT - 40;
    const x = WIDTH - 30 - boxW; // right:30px

    const maxTextW = boxW - padX * 2 - avatarD - gapAvatarText;

    let cursorBottom = bottomY;

    state.commentNotifications.forEach((item, idx) => {
        const tokens = [
            { text: `${item.name}:`, font: `600 18px ${FONT_BOLD}`, color: "#ffbc00" },
            { text: item.action || "", font: `500 18px ${FONT_TEXT}`, color: "rgba(255,255,255,0.95)" },
        ];
        const lines = layoutInlineTokens(tokens, maxTextW);
        const textBlockH = lines.length * lineHeight;
        const contentH = Math.max(avatarD + 2, textBlockH); // +2 يطابق margin-top الأفاتار الأصلي
        const cardH = contentH + padY * 2;

        const cardBottom = cursorBottom;
        const cardTop = cardBottom - cardH;
        cursorBottom = cardTop - marginTop; // الكرت التالي (الأقدم) يرتفع فوقه بنفس فجوة margin-top

        // نفس منطق nth-child الأصلي: تدرّج خشن بالرتبة + قناع ناعم على كل الحاوية
        const tierAlpha = idx === 0 ? 1 : idx === 1 ? 0.75 : idx === 2 ? 0.5 : 0.25;
        const distanceFromBottom = bottomY - cardTop;
        const smoothMask = maskAlpha(distanceFromBottom, containerHeight, COMMENT_MASK_STOPS);
        const alpha = tierAlpha * smoothMask;
        if (alpha <= 0.01 || cardTop > HEIGHT) return;

        ctx.save();
        ctx.globalAlpha = alpha;

        ctx.fillStyle = "rgba(12,12,18,0.75)";
        roundRect(x, cardTop, boxW, cardH, 14);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // الأفاتار يلتصق بأعلى الكرت (align-items: flex-start الأصلي)، لا يتوسّط رأسياً
        const avatarCx = x + padX + avatarR;
        const avatarCy = cardTop + padY + 2 + avatarR;
        drawCircleImage(getImage(item.avatar), avatarCx, avatarCy, avatarR, "rgba(255,188,0,0.6)", 1);

        const textX = x + padX + avatarD + gapAvatarText;
        const textStartY = cardTop + padY + lineHeight * 0.78; // محاذاة خط الأساس مع أول سطر
        drawInlineLines(lines, textX, textStartY, lineHeight);

        ctx.restore();
    });
}

function drawLogo() {
    if (!logoImg) return;
    const w = 300;
    const h = (logoImg.height / logoImg.width) * w;
    ctx.globalAlpha = 1;
    ctx.drawImage(logoImg, WIDTH / 2 - w / 2, HEIGHT / 2 - h / 2, w, h);
}

function drawBubble(cx, y) {
    if (!state.bubbleText || !state.bubblePalette) return;
    const elapsed = Date.now() - state.bubbleShownAt;
    let alpha = 0;
    if (elapsed < BUBBLE_FADE_MS) alpha = elapsed / BUBBLE_FADE_MS;
    else if (elapsed < BUBBLE_HOLD_MS) alpha = 1;
    else if (elapsed < BUBBLE_HOLD_MS + BUBBLE_FADE_MS) alpha = 1 - (elapsed - BUBBLE_HOLD_MS) / BUBBLE_FADE_MS;
    else return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 16px ${FONT_BOLD}`;
    const textW = ctx.measureText(state.bubbleText).width;
    const boxW = textW + 40, boxH = 36;

    ctx.fillStyle = state.bubblePalette.bg;
    roundRect(cx - boxW / 2, y - boxH / 2, boxW, boxH, 30);
    ctx.fill();
    ctx.strokeStyle = state.bubblePalette.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.textAlign = "center";
    ctx.fillText(state.bubbleText, cx, y + 5);
    ctx.restore();
}

function drawTasbih() {
    const cx = WIDTH / 2;
    const barW = 500, barH = 44;
    const barX = cx - barW / 2;
    const barY = 25;

    ctx.fillStyle = "rgba(255,192,203,0.25)";
    roundRect(barX, barY, barW, barH, 22);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,182,193,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // التعبئة تمتلئ من اليمين، نفس الأصل
    const fillW = (Math.max(0, Math.min(100, state.tasbihPercentage)) / 100) * barW;
    if (fillW > 0) {
        ctx.save();
        roundRect(barX, barY, barW, barH, 22);
        ctx.clip();
        ctx.fillStyle = "#39FF14";
        ctx.shadowColor = "#39FF14";
        ctx.shadowBlur = 16;
        ctx.fillRect(barX + barW - fillW, barY, fillW, barH);
        ctx.restore();
    }

    // الأرقام بالمنتصف مع تأثير bump خفيف عند التحديث
    const bumpElapsed = Date.now() - state.tasbihBumpAt;
    const bumpScale = bumpElapsed < 100 ? 1 + 0.15 * (1 - bumpElapsed / 100) : 1;
    ctx.save();
    ctx.translate(cx, barY + barH / 2);
    ctx.scale(bumpScale, bumpScale);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 20px ${FONT_XBOLD}`;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4;
    ctx.fillText(state.tasbihNumbersText, 0, 7);
    ctx.restore();
    ctx.shadowBlur = 0;

    // الساب تكست
    const subY = barY + barH + 6 + 30;
    const subText = (state.currentAzkarItem || AZKAR_LIST[0]).sub;
    ctx.font = `600 20px ${FONT_TEXT}`;
    const subW = Math.min(barW * 0.95, ctx.measureText(subText).width + 16);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    roundRect(cx - subW / 2, subY - 18, subW, 26, 10);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textAlign = "center";
    ctx.fillText(truncateText(subText, subW - 16), cx, subY);

    drawBubble(cx, subY + 46);
}

function drawClock() {
    const now = new Date();
    const ksa = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
    const h = String(ksa.getHours()).padStart(2, "0");
    const m = String(ksa.getMinutes()).padStart(2, "0");
    const timeText = `${h}:${m}`;

    const boxW = 120, boxH = 56;
    const x = 25, y = 25;

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(x, y, boxW, boxH, 14);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 21px ${FONT_BOLD}`;
    ctx.fillText(timeText, x + boxW / 2, y + 26);

    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `600 12px ${FONT_TEXT}`;
    ctx.fillText("مكة المكرمة", x + boxW / 2, y + 44);
}

function drawStats() {
    const viewersText = `👤 ${state.viewerCount.toLocaleString()}`;
    const likesText = `❤️ ${state.totalLikes.toLocaleString()}`;

    ctx.font = `700 21px ${FONT_BOLD}`;
    const gap = 20, padX = 25, padY = 10;
    const w1 = ctx.measureText(viewersText).width;
    const w2 = ctx.measureText(likesText).width;
    const boxW = w1 + w2 + gap + padX * 2;
    const boxH = 21 + padY * 2;
    const x = WIDTH - 25 - boxW;
    const y = 25;

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(x, y, boxW, boxH, 16);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(viewersText, x + padX, y + boxH / 2 + 7);
    ctx.fillText(likesText, x + padX + w1 + gap, y + boxH / 2 + 7);
}

function drawFollowBanner() {
    if (state.follow && Date.now() > state.followHideAt) state.follow = null;
    if (!state.follow) return;
    const f = state.follow;

    const avatarR = 26, avatarD = avatarR * 2;
    const padX = 20;
    const gapTextAvatar = 14;
    const gapCountText = 20;
    const boxH = 72;

    ctx.font = `700 20px ${FONT_BOLD}`;
    const nameW = ctx.measureText(f.name).width;
    ctx.font = `800 11px ${FONT_XBOLD}`;
    const labelW = ctx.measureText("FOLLOW 👤").width;
    const textBlockW = Math.max(nameW, labelW);

    const countText = `👥 ${f.count}`;
    ctx.font = `600 14px ${FONT_TEXT}`;
    const countTextW = ctx.measureText(countText).width;
    const cbW = countTextW + 28, cbH = 30;

    // عرض الصندوق يحتسب كل العناصر (الأفاتار + النص + صندوق العداد) فلا يتجاوز أي عنصر الحدود
    const contentW = padX + cbW + gapCountText + textBlockW + gapTextAvatar + avatarD + padX;
    const boxW = Math.max(320, contentW);
    const x = WIDTH / 2 - boxW / 2;
    const y = HEIGHT - 90 - boxH;

    ctx.fillStyle = "rgba(20,15,30,0.75)";
    roundRect(x, y, boxW, boxH, 50);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // الأفاتار في أقصى اليمين
    const avatarCx = x + boxW - padX - avatarR;
    const avatarCy = y + boxH / 2;
    drawCircleImage(getImage(f.avatar), avatarCx, avatarCy, avatarR, "#ffbc00", 2);

    // النص (Follow + الاسم) يسار الأفاتار مباشرة
    const textRightEdge = avatarCx - avatarR - gapTextAvatar;
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffbc00";
    ctx.font = `800 11px ${FONT_XBOLD}`;
    ctx.fillText("FOLLOW 👤", textRightEdge, avatarCy - 8);

    ctx.fillStyle = "#ffffff";
    ctx.font = `700 20px ${FONT_BOLD}`;
    ctx.fillText(f.name, textRightEdge, avatarCy + 14);

    // صندوق العداد في أقصى اليسار — الآن دايماً داخل حدود البنر
    const cbX = x + padX;
    const cbY = y + boxH / 2 - cbH / 2;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(cbX, cbY, cbW, cbH, 20);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = `600 14px ${FONT_TEXT}`;
    ctx.fillText(countText, cbX + cbW / 2, cbY + cbH / 2 + 5);
}

function drawGiftBanner() {
    if (state.gift && Date.now() > state.giftHideAt) state.gift = null;
    if (!state.gift) return;
    const g = state.gift;

    const boxW = 460, boxH = 100;
    const x = WIDTH / 2 - boxW / 2;
    const y = 160;

    ctx.fillStyle = "rgba(30,20,50,0.92)";
    roundRect(x, y, boxW, boxH, 24);
    ctx.fill();
    ctx.strokeStyle = "#ffbc00";
    ctx.lineWidth = 2;
    ctx.stroke();

    const avatarR = 24;
    const avatarCx = x + 32 + avatarR;
    const avatarCy = y + boxH / 2;
    drawCircleImage(getImage(g.avatar), avatarCx, avatarCy, avatarR, "rgba(255,255,255,0.6)", 2);

    const textX = avatarCx + avatarR + 16;
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 16px ${FONT_XBOLD}`;
    ctx.fillText(` شكراً: ${g.name}`, textX, avatarCy - 8);

    // عداد التكرار بتأثير pop عند كل تحديث (count-pop الأصلي)
    const bumpElapsed = Date.now() - (g.lastBumpAt || g.shownAt);
    const popScale = bumpElapsed < 150 ? 1 + 0.3 * (1 - bumpElapsed / 150) : 1;
    ctx.save();
    ctx.translate(textX, avatarCy + 14);
    ctx.scale(popScale, popScale);
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffff00";
    ctx.font = `700 17px ${FONT_BOLD}`;
    ctx.fillText(`${g.giftName} × ${g.count}`, 0, 0);
    ctx.restore();

    // أيقونة الهدية بنبض خفيف مستمر (popScale infinite alternate الأصلي)
    const giftImg = getImage(g.giftIcon);
    if (giftImg) {
        const t = (Date.now() % 800) / 800;
        const pulse = 1 + 0.15 * Math.abs(Math.sin(t * Math.PI));
        const baseSize = 70;
        const size = baseSize * pulse;
        const gx = x + boxW - 32 - baseSize / 2;
        const gy = y + boxH / 2;
        ctx.save();
        ctx.shadowColor = "#ffbc00";
        ctx.shadowBlur = 14;
        ctx.drawImage(giftImg, gx - size / 2, gy - size / 2, size, size);
        ctx.restore();
    }
}

function roundRectAt(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawMilestoneBanner() {
    if (!state.isMilestoneActive) return;
    const elapsed = Date.now() - state.milestoneShownAt;
    const t = Math.min(1, elapsed / 500);
    const scale = 0.5 + 0.5 * (1 - Math.pow(1 - t, 3)); // ease-out تقريبي لنفس إحساس CSS

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const boxW = 560, boxH = 220;
    ctx.translate(WIDTH / 2, HEIGHT / 2);
    ctx.scale(scale, scale);

    const grad = ctx.createLinearGradient(-boxW / 2, -boxH / 2, boxW / 2, boxH / 2);
    grad.addColorStop(0, "rgba(255,20,147,0.9)");
    grad.addColorStop(1, "rgba(139,0,139,0.9)");
    ctx.fillStyle = grad;
    roundRectAt(-boxW / 2, -boxH / 2, boxW, boxH, 30);
    ctx.fill();
    ctx.strokeStyle = "#39FF14";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#39FF14";
    ctx.shadowBlur = 30;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 36px ${FONT_BOLD}`;
    ctx.fillText("تم تحقيق الهدف!", 0, -20);

    ctx.fillStyle = "#ffcc00";
    ctx.font = `700 24px ${FONT_BOLD}`;
    ctx.fillText(state.milestoneText, 0, 30);

    ctx.restore();
}

// ──────────────────────────────────────────────
// 8. الدالة الرئيسية — تُستدعى من server.js في كل فريم
// ──────────────────────────────────────────────
function renderFrame() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // نفس ترتيب z-index في overlay.html الأصلي، من الخلف للأمام
    drawJoinNotifications();    // z-index: auto (0) — يسار الشاشة
    drawCommentNotifications(); // z-index: auto (0) — يمين الشاشة
    drawLogo();              // z-index: 50
    drawTasbih();             // z-index: 100
    drawClock();                // z-index: 100
    drawStats();                  // z-index: 100
    drawFollowBanner();              // z-index: 200
    drawGiftBanner();                  // z-index: 900
    drawMilestoneBanner();               // z-index: 1000 (الأعلى دائماً)

    return canvas.toBuffer("image/png");
}

module.exports = {
    renderFrame,
    setViewerCount,
    setLikes,
    addJoin,
    addComment,
    setFollow,
    setGift,
};
