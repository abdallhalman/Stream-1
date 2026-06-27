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

// Almarai + خطوط Noto Symbols/Symbols2/Math ليست خطوط نظام (Math و Symbols أصلاً غير متوفرة
// عبر apt في دبيان/أوبنتو إطلاقاً، حتى مع تثبيت fonts-noto الكامل — لازم تنزيلها يدوياً من
// google/fonts بالضبط كما نسوي مع Almarai). تتحمّل بخطوة الـ workflow لمجلد fonts/ وتُسجَّل هنا.
const FONTS_DIR = path.join(__dirname, "fonts");
const customFonts = [
    ["Almarai-Regular.ttf", "Almarai"],
    ["Almarai-Bold.ttf", "Almarai Bold"],
    ["Almarai-ExtraBold.ttf", "Almarai ExtraBold"],
    ["NotoSansSymbols-Regular.ttf", "Noto Sans Symbols"],
    ["NotoSansSymbols2-Regular.ttf", "Noto Sans Symbols 2"],
    ["NotoSansMath-Regular.ttf", "Noto Sans Math"], // يغطي تحديداً حروف "الخط الزخرفي" 𝓮𝔁𝓪𝓶𝓹𝓵𝓮 اللي تستخدمها أسماء تيك توك
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

// أضفنا "Noto Sans Symbols/Symbols 2" (لرموز اليونيكود النادرة) و"DejaVu Sans" (تغطية واسعة
// جداً تشمل أغلب أحرف "الخطوط الزخرفية" اللي تستخدمها أسماء تيك توك) كحل أخير قبل sans-serif.
// هذا يعتمد على تثبيت الحزم المقابلة في خطوة setup بالـ workflow (راجع شرح الرد).
const FONT_FALLBACK_TAIL = `"Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math", "Noto Sans CJK SC", "Noto Sans Thai", "Noto Sans Devanagari", "Noto Sans Hebrew", "Noto Color Emoji", "DejaVu Sans", sans-serif`;

const FONT_TEXT  = `"Almarai", "Noto Sans Arabic", "Noto Sans", ${FONT_FALLBACK_TAIL}`;
const FONT_BOLD  = `"Almarai Bold", "Almarai", "Noto Sans Arabic", "Noto Sans", ${FONT_FALLBACK_TAIL}`;
const FONT_XBOLD = `"Almarai ExtraBold", "Almarai Bold", "Almarai", "Noto Sans Arabic", ${FONT_FALLBACK_TAIL}`;

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
    { main: "سبحان الله",      sub: "🌿 سبحان الله وبحمده، سبحان الله العظيم" },
    { main: "الحمد لله",       sub: "🤍 الحمد لله حمدا كثيرا طيبا مباركا فيه" },
    { main: "لا إله إلا الله", sub: "🤲 لا إله إلا الله وحده لا شريك له"      },
    { main: "الله أكبر",       sub: "☝️ الله أكبر كبيرا، والحمد لله كثيرا "    },
    { main: "أستغفر الله",     sub: "🕋 أستغفر الله العظيم وأتوب إليه"         },
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
        state.milestoneText = `الذكر التالي: ${currentItem.main}`;
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

function pushNotification(list, kind, name, action, avatar, pushAmount) {
    const now = Date.now();

    // الكروت الموجودة "تُدفع" للأعلى: نضيف مقدار الدفعة لإزاحتها الحالية المتبقية (لا نستبدلها)
    // فلو توالت إشعارات بسرعة، الحركة تبقى متصلة وسلسة بدون قفزات.
    list.forEach((item) => {
        const leftover = currentAnimOffset(item, now);
        item.animStartOffset = leftover + pushAmount;
        item.animFrom = now;
    });

    list.unshift({
        kind,
        name: name || (kind === "join" ? "متابع جديد" : "متابع"),
        action: action || "",
        avatar: avatar || FALLBACK_AVATAR,
        color: randomColor(),
        createdAt: now,
        animFrom: now,
        animStartOffset: pushAmount, // يدخل من خطوة واحدة تحت موقعه، فيبدو أنه "يزحف" للأعلى مع الباقي
    });
    if (list.length > NOTIF_MAX) list.length = NOTIF_MAX;
}

function addJoin({ name, avatar }) {
    pushNotification(state.joinNotifications, "join", name, "انضم إلى البث الآن ✨", avatar, JOIN_STEP_Y);
}

function addComment({ name, text, avatar }) {
    // نحسب ارتفاع الكرت الفعلي (حسب طول النص) قبل الإضافة، لمعرفة مقدار الدفع الصحيح للكروت الأقدم
    const tokens = [
        { text: `${name || "متابع"}:`, font: `700 18px ${FONT_BOLD}` },
        { text: text || "", font: `600 18px ${FONT_TEXT}` },
    ];
    const lines = layoutInlineTokens(tokens, COMMENT_MAX_TEXT_W);
    const contentH = Math.max(COMMENT_AVATAR_D + 2, lines.length * COMMENT_LINE_HEIGHT);
    const cardH = contentH + COMMENT_PAD_Y * 2;
    const pushAmount = cardH + COMMENT_MARGIN_TOP;

    pushNotification(state.commentNotifications, "comment", name, text, avatar, pushAmount);
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

// المشكلة الأصلية: drawInlineLines يفرض ترتيب "عربي" (يمين→يسار) على كل التعليقات بدون استثناء،
// وهذا صحيح للعربي لكنه يقلب ترتيب الكلمات لأي تعليق لاتيني/إنجليزي (يطلع آخر كلمة أول).
// الحل: نكشف اتجاه التعليق فعلياً (عربي/عبري = RTL، أي شي ثاني = LTR) ونختار دالة الرسم المناسبة.
const RTL_CHARS_REGEX = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
function isRTLText(str) {
    return RTL_CHARS_REGEX.test(String(str || ""));
}

// ──────────────────────────────────────────────
// 7. الرسم — كل عنصر بدالته الخاصة، بترتيب z-index الأصلي (من الخلف للأمام)
// ──────────────────────────────────────────────

// نظام تلاشي مبسّط ومباشر: التحكم بعدد الأشرطة لا بالنسبة المئوية للمسافة.
// alpha = 1 لكل الأشرطة من 0 حتى FADE_START_INDEX، وبعدها تتلاشى خطياً حتى FADE_END_INDEX.
function fadeAlphaByIndex(idx, fadeStartIndex, fadeEndIndex) {
    if (idx < fadeStartIndex) return 1;
    if (idx >= fadeEndIndex) return 0;
    const t = (idx - fadeStartIndex) / (fadeEndIndex - fadeStartIndex);
    return 1 - t;
}

// ── إعدادات قابلة للتعديل المباشر ──
const JOIN_EDGE_MARGIN     = 30; // المسافة بين كروت الانضمام وحافة الشاشة (يسار)
const COMMENT_EDGE_MARGIN  = 30; // المسافة بين كروت التعليقات وحافة الشاشة (يمين)

const JOIN_FADE_START_INDEX    = 1; // أول 4 أشرطة (idx 0..3) معتمة بالكامل، الخامس (idx 4) يبدأ التلاشي
const JOIN_FADE_END_INDEX      = 9; // يختفي تماماً عند الشريط العاشر (idx 9)
const COMMENT_FADE_START_INDEX = 1;
const COMMENT_FADE_END_INDEX   = 9;

const JOIN_STEP_Y = 65; // المسافة بين كرت انضمام وكرت — نفس قيمة الدفع المستخدمة بالحركة

// مقاسات كرت التعليق — موحّدة هنا لاستخدامها بحساب الدفع (push) وبالرسم معاً، فلا تتعارض القيم
const COMMENT_BOX_W           = 380;
const COMMENT_PAD_X           = 12;
const COMMENT_PAD_Y           = 6;
const COMMENT_AVATAR_R        = 17;
const COMMENT_AVATAR_D        = COMMENT_AVATAR_R * 2;
const COMMENT_GAP_AVATAR_TEXT = 10;
const COMMENT_LINE_HEIGHT     = 24;
const COMMENT_MARGIN_TOP      = 8;
const COMMENT_MAX_TEXT_W      = COMMENT_BOX_W - COMMENT_PAD_X * 2 - COMMENT_AVATAR_D - COMMENT_GAP_AVATAR_TEXT;

// ── حركة "الزحف والدفع" عند دخول إشعار جديد ──
const ANIM_DURATION_MS = 900;
function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}
// الإزاحة الحالية المتبقية للكرت (تتلاشى من animStartOffset إلى 0 خلال ANIM_DURATION_MS)
function currentAnimOffset(item, now) {
    if (!item.animFrom) return 0;
    const t = Math.min(1, (now - item.animFrom) / ANIM_DURATION_MS);
    return item.animStartOffset * (1 - easeOutCubic(t));
}

function drawNotificationStack(list, x) {
    const boxW = 360;
    const cardH = 54;
    const stepY = JOIN_STEP_Y; // المسافة بين كرت وكرت — كبّرها لتباعد أكثر
    const bottomY = HEIGHT - 40;
    const now = Date.now();

    // [0] = الأحدث ويظهر بالأسفل (أقرب للحافة)، الأقدم يرتفع للأعلى ويتلاشى تدريجياً
    list.forEach((item, idx) => {
        const cardBottom = bottomY - idx * stepY;
        const targetY = cardBottom - cardH;
        const y = targetY + currentAnimOffset(item, now); // الموضع الفعلي للرسم خلال حركة الزحف
        const alpha = fadeAlphaByIndex(idx, JOIN_FADE_START_INDEX, JOIN_FADE_END_INDEX);
        if (alpha <= 0.01) return; // تلاشى تماماً، لا داعي لرسمه

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

        const avatarR = 18;
        const avatarCx = x + 16 + avatarR;
        const avatarCy = y + cardH / 2;
        drawCircleImage(getImage(item.avatar), avatarCx, avatarCy, avatarR, "rgba(255,255,255,0.4)", 1);

        const textX = avatarCx + avatarR + 14;
        const maxTextW = boxW - (textX - x) - 16;
        ctx.textAlign = "left";
        ctx.fillStyle = item.kind === "comment" ? "#ffbc00" : "#ffffff";
        ctx.font = `600 18px ${FONT_BOLD}`;
        ctx.fillText(truncateText(item.name, maxTextW), textX, avatarCy - 4);

        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = `600 12px ${FONT_TEXT}`;
        ctx.fillText(truncateText(item.action, maxTextW), textX, avatarCy + 16);

        ctx.restore();
    });
}

function drawJoinNotifications() {
    drawNotificationStack(state.joinNotifications, JOIN_EDGE_MARGIN); // يسار الشاشة
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

function drawInlineLines(lines, rightEdgeX, startY, lineHeight) {
    // العربي يُقرأ يمين→يسار: أول كلمة بالسطر تُرسم أقصى اليمين، وكل كلمة تالية تتحرك يساراً
    let cy = startY;
    lines.forEach((line) => {
        let cx = rightEdgeX;
        ctx.textAlign = "right";
        line.forEach((word) => {
            ctx.font = word.font;
            ctx.fillStyle = word.color;
            ctx.fillText(word.text, cx, cy);
            cx -= measureWith(word.text, word.font) + measureWith(" ", word.font);
        });
        cy += lineHeight;
    });
}

// نسخة مرآة من drawInlineLines لأي اتجاه غير عربي (إنجليزي، روسي، إلخ):
// أول كلمة بالسطر تُرسم أقصى اليسار، وكل كلمة تالية تتحرك يميناً — نفس منطق المتصفح لنص LTR عادي.
function drawInlineLinesLTR(lines, leftEdgeX, startY, lineHeight) {
    let cy = startY;
    lines.forEach((line) => {
        let cx = leftEdgeX;
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
    const boxW = COMMENT_BOX_W;       // نفس عرض #chat-container الأصلي
    const padX = COMMENT_PAD_X, padY = COMMENT_PAD_Y;
    const avatarR = COMMENT_AVATAR_R, avatarD = COMMENT_AVATAR_D;
    const gapAvatarText = COMMENT_GAP_AVATAR_TEXT;
    const lineHeight = COMMENT_LINE_HEIGHT;
    const marginTop = COMMENT_MARGIN_TOP;
    const bottomY = HEIGHT - 40;
    const x = WIDTH - COMMENT_EDGE_MARGIN - boxW;
    const now = Date.now();

    const maxTextW = COMMENT_MAX_TEXT_W;

    let cursorBottom = bottomY;

    state.commentNotifications.forEach((item, idx) => {
        const tokens = [
            { text: `${item.name}:`, font: `600 18px ${FONT_BOLD}`, color: "#ffbc00" },
            { text: item.action || "", font: `600 18px ${FONT_TEXT}`, color: "rgba(255,255,255,0.95)" },
        ];
        const lines = layoutInlineTokens(tokens, maxTextW);
        const textBlockH = lines.length * lineHeight;
        const contentH = Math.max(avatarD + 2, textBlockH); // +2 يطابق margin-top الأفاتار الأصلي
        const cardH = contentH + padY * 2;

        // الموضع المنطقي (الهدف) — يُستخدم لحساب تراكم الكروت، لا يتأثر بالحركة
        const cardBottom = cursorBottom;
        const cardTop = cardBottom - cardH;
        cursorBottom = cardTop - marginTop; // الكرت التالي (الأقدم) يرتفع فوقه بنفس فجوة margin-top

        const alpha = fadeAlphaByIndex(idx, COMMENT_FADE_START_INDEX, COMMENT_FADE_END_INDEX);
        if (alpha <= 0.01 || cardTop > HEIGHT) return;

        // الموضع الفعلي للرسم خلال حركة الزحف (يبدأ أسفل الهدف بمقدار الدفعة ثم يتلاشى الفرق)
        const renderTop = cardTop + currentAnimOffset(item, now);

        ctx.save();
        ctx.globalAlpha = alpha;

        ctx.fillStyle = "rgba(12,12,18,0.75)";
        roundRect(x, renderTop, boxW, cardH, 14);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // الأفاتار يلتصق بأعلى الكرت (align-items: flex-start الأصلي)، ونقله لليمين ليطابق اتجاه القراءة العربي
        const avatarCx = x + boxW - padX - avatarR;
        const avatarCy = renderTop + padY + 2 + avatarR;
        drawCircleImage(getImage(item.avatar), avatarCx, avatarCy, avatarR, "rgba(255,188,0,0.6)", 1);

        const textStartY = renderTop + padY + lineHeight * 0.78; // محاذاة خط الأساس مع أول سطر
        const textLeftEdge = x + padX; // الحافة اليسرى لمنطقة النص (ثابتة بغض النظر عن الاتجاه)
        const textRightEdge = x + boxW - padX - avatarD - gapAvatarText; // الحافة اليمنى (يسار الأفاتار)

        // الاتجاه يتحدد حسب محتوى التعليق نفسه (الاسم + النص)، لا بشكل ثابت:
        // عربي/عبري → نفس منطق RTL الأصلي. أي لغة أخرى (إنجليزي، روسي، إلخ) → LTR بدون قلب ترتيب الكلمات.
        if (isRTLText(`${item.name} ${item.action}`)) {
            drawInlineLines(lines, textRightEdge, textStartY, lineHeight);
        } else {
            drawInlineLinesLTR(lines, textLeftEdge, textStartY, lineHeight);
        }

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
    const subY = barY + barH + 6 + 28;
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
    ctx.font = `600 10px ${FONT_TEXT}`;
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

    const avatarR = 36, avatarD = avatarR * 2;
    const padX = 28;
    const gapTextAvatar = 20;
    const gapCountText = 28;
    const boxH = 100;

    ctx.font = `700 28px ${FONT_BOLD}`;
    const nameW = ctx.measureText(f.name).width;
    ctx.font = `800 15px ${FONT_XBOLD}`;
    const labelW = ctx.measureText("FOLLOW 👤").width;
    const textBlockW = Math.max(nameW, labelW);

    const countText = `👥 ${f.count}`;
    ctx.font = `600 19px ${FONT_TEXT}`;
    const countTextW = ctx.measureText(countText).width;
    const cbW = countTextW + 36, cbH = 42;

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
    drawCircleImage(getImage(f.avatar), avatarCx, avatarCy, avatarR, "#ffbc00", 3);

    // النص (Follow + الاسم) يسار الأفاتار مباشرة
    const textRightEdge = avatarCx - avatarR - gapTextAvatar;
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffbc00";
    ctx.font = `800 15px ${FONT_XBOLD}`;
    ctx.fillText("FOLLOW 👤", textRightEdge, avatarCy - 12);

    ctx.fillStyle = "#ffffff";
    ctx.font = `700 28px ${FONT_BOLD}`;
    ctx.fillText(f.name, textRightEdge, avatarCy + 18);

    // صندوق العداد في أقصى اليسار — الآن دايماً داخل حدود البنر
    const cbX = x + padX;
    const cbY = y + boxH / 2 - cbH / 2;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(cbX, cbY, cbW, cbH, 26);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = `600 19px ${FONT_TEXT}`;
    ctx.fillText(countText, cbX + cbW / 2, cbY + cbH / 2 + 7);
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
