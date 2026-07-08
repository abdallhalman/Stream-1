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

// Almarai + Noto Color Emoji + خطوط Noto Symbols/Symbols2/Math كلها تُسجَّل يدوياً.
// السبب الجوهري: Skia يعطي الخطوط المسجلة بـ registerFromPath أولوية على خطوط النظام
// (المثبتة عبر apt) عند البحث عن الـ glyph — بغض النظر عن ترتيبهم في ctx.font.
// لذلك fonts-noto-color-emoji المثبّت عبر apt كان يخسر أمام Symbols2 المسجّل يدوياً،
// فتظهر الإيموجي أحادية اللون. الحل: نسجّل Noto Color Emoji يدوياً أيضاً ونضعه أولاً
// في القائمة — هكذا Skia يجده أول من يبحث ويأخذ النسخة الملوّنة.
const FONTS_DIR = path.join(__dirname, "fonts");
const customFonts = [
    ["NotoColorEmoji.ttf", "Noto Color Emoji"],      // ← أولاً دائماً: يضمن الإيموجي الملوّن قبل Symbols
    ["Almarai-Regular.ttf", "Almarai"],
    ["Almarai-Bold.ttf", "Almarai Bold"],
    ["Almarai-ExtraBold.ttf", "Almarai ExtraBold"],
    ["NotoSansSymbols-Regular.ttf", "Noto Sans Symbols"],
    ["NotoSansSymbols2-Regular.ttf", "Noto Sans Symbols 2"],
    ["NotoSansMath-Regular.ttf", "Noto Sans Math"],
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
// مهم: "Noto Color Emoji" لازم يجي قبل خطوط Symbols/Math، لأن رموز كثيرة (⭐❤️✅☀️▶️) موجودة
// بالخطين معاً — الرندرر يختار أول خط بالقائمة يحتوي الرمز، فلو Symbols قبل، تطلع أحادية اللون
// حتى لو فيها نسخة ملونة بـ Color Emoji. خطوط Symbols/Math تبقى حل أخير فقط لما لا توجد بـ Color Emoji إطلاقاً.
const FONT_FALLBACK_TAIL = `"Noto Color Emoji", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math", "Noto Sans CJK SC", "Noto Sans Thai", "Noto Sans Devanagari", "Noto Sans Hebrew", "DejaVu Sans", sans-serif`;

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

// حد أقصى لعدد الصور المخزّنة بالكاش بنفس الوقت. بدون هذا الحد، كل أفاتار فريد
// (كل مشاهد/معلّق/متابع جديد طول البث) يتراكم بالذاكرة للأبد ولا يُحذف أبداً —
// على بث طويل (10-12 ساعة) مع تفاعل قوي، هذا يضخّم استهلاك الذاكرة تدريجياً ويزيد
// توقفات garbage collection (تظهر كفريمات بطيئة)، وبالنهاية يضغط على الذاكرة كامل العملية.
// لما يتجاوز الكاش الحد، نحذف أقدم الصور (بترتيب أول ما دخلت الكاش) — لو احتجناها
// مرة ثانية بالمستقبل، تنزل من جديد عادي، بدون أي خسارة وظيفية.
const IMAGE_CACHE_MAX = 500;

function evictOldImagesIfNeeded() {
    while (imageCache.size > IMAGE_CACHE_MAX) {
        const oldestKey = imageCache.keys().next().value;
        imageCache.delete(oldestKey);
    }
}

function getImage(url) {
    if (!url) return null;
    const cached = imageCache.get(url);
    if (cached && cached !== "loading" && cached !== "failed") return cached;
    if (cached === "loading" || cached === "failed") return null;

    imageCache.set(url, "loading");
    loadImage(url)
        .then((img) => {
            imageCache.set(url, img);
            evictOldImagesIfNeeded();
        })
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
const MILESTONE_MS     = 4000; // كانت 10000 — قصّرناها حسب الطلب
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
    { bg: "rgba(57,255,20,0.28)",  border: "rgba(57,255,20,0.85)"  },
    { bg: "rgba(0,200,255,0.28)",  border: "rgba(0,200,255,0.85)"  },
    { bg: "rgba(255,188,0,0.28)",  border: "rgba(255,188,0,0.85)"  },
    { bg: "rgba(255,60,200,0.28)", border: "rgba(255,60,200,0.85)" },
    { bg: "rgba(157,93,255,0.28)", border: "rgba(157,93,255,0.85)" },
    { bg: "rgba(255,100,50,0.28)", border: "rgba(255,100,50,0.85)" },
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

function pushNotification(list, kind, name, action, avatar, pushAmount, extra) {
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
        ...extra, // بيانات جاهزة محسوبة مسبقاً (مثل أسطر التعليق) — تمنع إعادة الحساب كل فريم بالرسم
    });
    if (list.length > NOTIF_MAX) list.length = NOTIF_MAX;
}

function addJoin({ name, avatar }) {
    const safeName = name || "متابع جديد";
    const action = "انضم إلى البث الآن ✨";

    // نقصّ النص (truncate) مرة واحدة هنا، بدل إعادة قياسه حرف-حرف كل فريم بدالة الرسم —
    // نفس مبدأ تعليقات الدردشة: قياس النص مع سلسلة خطوط احتياطية طويلة مكلف، وتكراره
    // ١٠ مرات بالثانية لكل كرت انضمام نشط يزيد الحمل مع كثرة التفاعل بدون أي فايدة
    // (الاسم والنص الثابت لا يتغيران بعد إنشاء الكرت).
    ctx.font = `600 20px ${FONT_BOLD}`;
    const truncatedName = truncateText(safeName, JOIN_CARD_MAX_TEXT_W);
    ctx.font = `600 14px ${FONT_TEXT}`;
    const truncatedAction = truncateText(action, JOIN_CARD_MAX_TEXT_W);

    pushNotification(state.joinNotifications, "join", safeName, action, avatar, JOIN_STEP_Y, {
        truncatedName,
        truncatedAction,
    });
}

// يكسر نص الرسالة لأسطر بحسب العرض المتاح (للتخطيط فقط)، ويرجّع كل سطر كنص واحد متكامل
// (مو مصفوفة كلمات) — وقت الرسم نرسم كل سطر بنداء fillText واحد، فيحافظ محرك الخطوط على
// ترتيب القراءة الصحيح داخلياً تلقائياً (عربي، إنجليزي، أو خليط الاثنين بنفس السطر) بدون
// أي تخمين أو تدخل يدوي بترتيب الكلمات — هذا أصل المشكلة اللي كنا نواجهها بالتصنيف القديم.
// جدول استبدال إيموجي تيك توك الخاصة بنظيرها الـ Unicode
// يُستخدم كـ fallback لما emoteList فارغة أو ما تحمّل صورة الرمز
function applyEmoteFallback(text) {
    // رموز TikTok الخاصة ([thumb][heart] إلخ) مو Unicode — تيك توك يرندرها كصور بتطبيقه.
    // عبر connector تجي كنص خام مو مدعوم بأي خط، فنحذفها كلياً بدل ما تظهر بشكل غريب.
    return String(text || "").replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
}

// ── تحويل نص+emoteList لـ tokens مختلطة (نص / صورة إيموجي) ──
// emoteList من tiktok-live-connector: [{emoteId, emoteImageUrl, placeInTheList}]
// نقسّم النص عند كل رمز [..] ونُنتج tokens بالترتيب: نص ثم إيموجي ثم نص...
function buildMixedTokens(text, emoteList, textFont, textColor) {
    if (!emoteList || !emoteList.length) {
        // لا emoteList — نستبدل الرموز المعروفة بـ Unicode كـ fallback
        return [{ type: "text", text: applyEmoteFallback(String(text || "")), font: textFont, color: textColor }];
    }
    const tokens = [];
    const sorted = [...emoteList].sort((a, b) => (a.placeInTheList || 0) - (b.placeInTheList || 0));
    let remaining = String(text || "");
    for (const emote of sorted) {
        const m = remaining.match(/\[[^\]]+\]/);
        if (!m) break;
        const before = remaining.slice(0, m.index).trim();
        if (before) tokens.push({ type: "text", text: before, font: textFont, color: textColor });
        tokens.push({ type: "emote", url: emote.emoteImageUrl, size: 20 });
        remaining = remaining.slice(m.index + m[0].length);
    }
    const tail = remaining.trim();
    if (tail) tokens.push({ type: "text", text: tail, font: textFont, color: textColor });
    return tokens;
}

// ── التفاف tokens مختلطة على أسطر حسب maxWidth ──
// كل سطر = مصفوفة قطع جاهزة للرسم، كل قطعة فيها advance (عرضها + مسافة بعدها) محسوب مسبقاً
function wrapMixedTokens(tokens, firstLineMaxW, restMaxW) {
    const EM_PAD = 3;
    const rawLines = [];
    let line = [], lineW = 0, maxW = firstLineMaxW;

    function commit() {
        if (!line.length) return;
        // ── دمج كلمات متتالية من نفس الخط واللون في نص واحد ──
        // هذا الخطوة هي الأهم: لو خلّينا "hello world" ككلمتين منفصلتين ورسمناهم كل واحد
        // من اليمين، يطلع "world hello" (معكوس). لكن لو دمجناهم في fillText واحد،
        // canvas يرسم "hello world" بشكل صحيح وبترتيبه الطبيعي (bidi داخلي للمحرك).
        const merged = [];
        for (const p of line) {
            const last = merged[merged.length - 1];
            if (p.type === "text" && last && last.type === "text" && last.font === p.font && last.color === p.color) {
                last.text += " " + p.text;
            } else {
                merged.push({ ...p });
            }
        }
        // إعادة حساب عرض كل قطعة مدموجة بدقة
        merged.forEach(p => {
            if (p.type === "text") {
                ctx.font = p.font;
                p.advance = ctx.measureText(p.text).width + ctx.measureText(" ").width;
            }
        });
        rawLines.push(merged);
        line = []; lineW = 0; maxW = restMaxW;
    }

    for (const tok of tokens) {
        if (tok.type === "emote") {
            const w = (tok.size || 20) + EM_PAD * 2;
            if (lineW + w > maxW && line.length) commit();
            line.push({ ...tok, advance: w });
            lineW += w;
        } else {
            const words = String(tok.text || "").split(/\s+/).filter(Boolean);
            for (const word of words) {
                ctx.font = tok.font;
                const ww = ctx.measureText(word).width;
                const sp = ctx.measureText(" ").width;
                if (line.length && lineW + sp + ww > maxW) commit();
                const pad = line.length ? sp : 0;
                line.push({ type: "text", text: word, font: tok.font, color: tok.color, advance: ww + sp });
                lineW += pad + ww;
            }
        }
    }
    commit();
    return rawLines;
}

function wrapPlainText(text, font, firstLineMaxW, restMaxW) {
    ctx.font = font;
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let current = "";
    let maxW = firstLineMaxW;
    for (const w of words) {
        const candidate = current ? `${current} ${w}` : w;
        if (!current || ctx.measureText(candidate).width <= maxW) {
            current = candidate;
        } else {
            lines.push(current);
            current = w;
            maxW = restMaxW; // من السطر الثاني فصاعداً نستخدم العرض الكامل (ما عاد الاسم يشغل جزء منه)
        }
    }
    if (current) lines.push(current);
    return lines;
}

function addComment({ name, text, avatar, emoteList }) {
    const safeName = name || "متابع";
    const safeText = text || "";
    const nameFont = `700 18px ${FONT_BOLD}`;
    const textFont = `600 18px ${FONT_TEXT}`;
    const nameColor = "#ffbc00";
    const textColor = "#ffffff";

    // الاسم: قطعة نص ثابتة دائماً في أول سطر
    ctx.font = nameFont;
    const nameRun = `${safeName}: `;
    const nameW = ctx.measureText(nameRun).width;

    // نص الرسالة: نحوّله لـ tokens مختلطة (نص + إيموجي صور) ثم نلفّها على أسطر
    const msgTokens = buildMixedTokens(safeText, emoteList, textFont, textColor);
    const firstLineMaxW = Math.max(40, COMMENT_MAX_TEXT_W - nameW);
    // أول سطر يحمل الاسم + بداية الرسالة — نضيف الاسم كـ token أول ثم نلف الباقي
    const allTokens = [
        { type: "text", text: nameRun, font: nameFont, color: nameColor },
        ...msgTokens
    ];
    const cachedLines = wrapMixedTokens(allTokens, firstLineMaxW + nameW, COMMENT_MAX_TEXT_W);

    const contentH = Math.max(COMMENT_AVATAR_D + 2, cachedLines.length * COMMENT_LINE_HEIGHT);
    const cardH = contentH + COMMENT_PAD_Y * 2;
    const pushAmount = cardH + COMMENT_MARGIN_TOP;

    pushNotification(state.commentNotifications, "comment", safeName, safeText, avatar, pushAmount, {
        nameRun,
        nameW,
        cachedLines,
        cardH,
    });
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
        ctx.fillStyle = "rgba(255,255,255,0.28)";
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
// لازم نتحقق أيضاً من وجود حروف لاتينية فعلية، لأن تعليق "إيموجي فقط" (❤️🔥) ما فيه
// لا عربي ولا لاتيني — لو اعتبرناه LTR بالخطأ (لأن الفحص القديم بس يبحث عن عربي)
// يطلع بمظهر غريب/مختلف عن باقي التعليقات. الإيموجي والرموز المجردة تتبع اتجاه الواجهة (RTL).
const LATIN_CHARS_REGEX = /[A-Za-z\u00C0-\u024F\u0400-\u04FF]/; // لاتيني + سيريلي
function isRTLText(str) {
    const s = String(str || "");
    if (RTL_CHARS_REGEX.test(s)) return true;
    if (LATIN_CHARS_REGEX.test(s)) return false;
    return true; // لا عربي ولا لاتيني (إيموجي/رموز/أرقام فقط) → اتبع اتجاه الواجهة الأساسي
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

const JOIN_STEP_Y = 78; // المسافة بين كرت انضمام وكرت — كبّرناها مع زيادة ارتفاع الكرت

// مقاسات كرت الانضمام — موحّدة هنا لاستخدامها بالحساب المسبق (addJoin) وبالرسم معاً
const JOIN_CARD_BOX_W    = 360;
const JOIN_CARD_H        = 68;  // كانت 54 — كبّرناها حسب الطلب
const JOIN_CARD_AVATAR_R = 22;  // كانت 18
const JOIN_CARD_MAX_TEXT_W = JOIN_CARD_BOX_W - (16 + JOIN_CARD_AVATAR_R * 2 + 14) - 16;

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
    const boxW = JOIN_CARD_BOX_W;
    const cardH = JOIN_CARD_H;
    const stepY = JOIN_STEP_Y;
    const bottomY = HEIGHT - 40;
    const now = Date.now();

    list.forEach((item, idx) => {
        const cardBottom = bottomY - idx * stepY;
        const targetY = cardBottom - cardH;
        const y = targetY + currentAnimOffset(item, now);
        const alpha = fadeAlphaByIndex(idx, JOIN_FADE_START_INDEX, JOIN_FADE_END_INDEX);
        if (alpha <= 0.01) return;

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

        // في overlay.html الأصلي مع dir="rtl": الأفاتار يمين والنص يمتد من يمين الكرت يساراً.
        const avatarR = JOIN_CARD_AVATAR_R;
        const avatarCx = x + boxW - 16 - avatarR; // يمين الكرت
        const avatarCy = y + cardH / 2;
        drawCircleImage(getImage(item.avatar), avatarCx, avatarCy, avatarR, "rgba(255,255,255,0.4)", 1);

        // النص يبدأ من يسار الأفاتار ويتجه يساراً (textAlign="right" عند حافة الأفاتار)
        const textRightEdge = avatarCx - avatarR - 12;
        ctx.textAlign = "right";
        ctx.fillStyle = item.kind === "comment" ? "#ffbc00" : "#ffffff";
        ctx.font = `600 20px ${FONT_BOLD}`;
        ctx.fillText(truncateText(item.truncatedName, textRightEdge - x - 10), textRightEdge, avatarCy - 5);

        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = `600 14px ${FONT_TEXT}`;
        ctx.fillText(item.truncatedAction ? truncateText(item.truncatedAction, textRightEdge - x - 10) : "", textRightEdge, avatarCy + 19);

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

// ── رسم سطر مختلط (نص + إيموجي صور) من اليمين لليسار ──
// كل قطعة: {type:"text", text, font, color, advance} أو {type:"emote", url, size, advance}
// نبدأ من rightEdge ونتحرك يساراً بقيمة advance كل قطعة — تماماً كـ dir="rtl" بالمتصفح
function drawMixedLine(pieces, rightEdge, cy, lineHeight) {
    const EM_PAD = 3;
    let cx = rightEdge;
    ctx.textAlign = "right";
    for (const p of pieces) {
        if (p.type === "emote") {
            const sz = p.size || 20;
            const img = getImage(p.url);
            if (img && img.width) {
                ctx.drawImage(img, cx - sz - EM_PAD, cy - sz * 0.82, sz, sz);
            }
            cx -= p.advance;
        } else {
            ctx.font = p.font;
            ctx.fillStyle = p.color;
            ctx.fillText(p.text, cx, cy);
            cx -= p.advance;
        }
    }
}

// ── لماذا تغيّرت هذي الدالة بالكامل ──
// التقسيم القديم كان يفكك كل التعليق لكلمات منفصلة، ويرسم كل كلمة بـ fillText مستقلة
// بموضعها المحسوب يدوياً. هذا يعمل تمام لتعليق "نقي" (كله عربي أو كله إنجليزي)، لكنه يكسر
// أي تعليق يخلط سكربتات/رموز داخل نفس الكلمة أو الجملة (مثل اسم زخرفي فيه حروف عربي ممزوجة
// برموز/علامات تشكيل، أو جملة فيها كلمة عربي وكلمة إنجليزي متجاورتين) — لأن خوارزمية الاتجاه
// الثنائي (Unicode Bidi) الحقيقية تعمل على مستوى "النص الكامل"، وتكسيره كلمة-كلمة ثم إعادة
// ترتيبها يدوياً يفقد هذا السياق تماماً، فتطلع النتيجة مبعثرة بالضبط كما بالصورة.
//
// الحل الصحيح: لسا نحسب الالتفاف (wrap) كلمة-كلمة (لازم نعرف وين ينكسر كل سطر بدقة)،
// لكن وقت التجميع النهائي، نلصق كل الكلمات المتتالية اللي من نفس التوكن (نفس اللون/الخط)
// بنص واحد متصل، ونرسلها لـ fillText كنداء واحد. هذا يفعّل محرك الخطوط (Skia) ليطبّق
// الـ bidi الصحيح تلقائياً داخل كل قطعة (segment) — تماماً كيف يتعامل المتصفح مع
// dir="auto" — بدل ما نعيد ابتكار الخوارزمية يدوياً وبشكل خاطئ.
function layoutInlineTokens(tokens, maxWidth) {
    const lines = [];
    let lineWords = []; // كل عنصر: { word, font, color } — مؤقت لحساب الالتفاف فقط

    function lineWidthWith(words) {
        let total = 0;
        words.forEach((w, i) => {
            total += measureWith(w.word, w.font);
            if (i > 0) total += measureWith(" ", w.font);
        });
        return total;
    }

    function commitLine() {
        if (!lineWords.length) return;
        // نجمع الكلمات المتتالية المتشابهة بالخط واللون بقطعة واحدة متصلة النص
        const segments = [];
        let cur = null;
        lineWords.forEach((w) => {
            if (cur && cur.font === w.font && cur.color === w.color) {
                cur.words.push(w.word);
            } else {
                if (cur) segments.push(cur);
                cur = { font: w.font, color: w.color, words: [w.word] };
            }
        });
        if (cur) segments.push(cur);
        segments.forEach((seg) => {
            seg.text = seg.words.join(" "); // نص متصل واحد — يحافظ على ترتيب bidi الداخلي الصحيح
            seg.width = measureWith(seg.text, seg.font);
            delete seg.words;
        });
        lines.push(segments);
        lineWords = [];
    }

    tokens.forEach((tok) => {
        String(tok.text).split(" ").forEach((w) => {
            if (!w.length) return;
            const trial = [...lineWords, { word: w, font: tok.font, color: tok.color }];
            if (lineWords.length > 0 && lineWidthWith(trial) > maxWidth) {
                commitLine();
                lineWords = [{ word: w, font: tok.font, color: tok.color }];
            } else {
                lineWords = trial;
            }
        });
    });
    commitLine();
    return lines;
}

// كل سطر الآن مصفوفة "قطع" (segments) بدل كلمات. كل قطعة تُرسم بنداء fillText واحد
// لنصها الكامل المتصل — فيحافظ على ترتيب الأحرف الصحيح داخلها (bidi طبيعي من محرك الخطوط)،
// والقطع نفسها (عادة قطعتين: الاسم، ثم النص) تُرتَّب يمين→يسار بنفس منطق القراءة العربي.
function drawInlineLines(lines, rightEdgeX, startY, lineHeight) {
    let cy = startY;
    lines.forEach((segments) => {
        let cx = rightEdgeX;
        ctx.textAlign = "right";
        segments.forEach((seg) => {
            ctx.font = seg.font;
            ctx.fillStyle = seg.color;
            ctx.fillText(seg.text, cx, cy);
            cx -= seg.width + measureWith(" ", seg.font);
        });
        cy += lineHeight;
    });
}

// نسخة مرآة من drawInlineLines لأي اتجاه غير عربي (إنجليزي، روسي، إلخ):
// أول قطعة بالسطر تُرسم أقصى اليسار، وكل قطعة تالية تتحرك يميناً — نفس منطق المتصفح لنص LTR عادي.
function drawInlineLinesLTR(lines, leftEdgeX, startY, lineHeight) {
    let cy = startY;
    lines.forEach((segments) => {
        let cx = leftEdgeX;
        ctx.textAlign = "left";
        segments.forEach((seg) => {
            ctx.font = seg.font;
            ctx.fillStyle = seg.color;
            ctx.fillText(seg.text, cx, cy);
            cx += seg.width + measureWith(" ", seg.font);
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

    let cursorBottom = bottomY;

    state.commentNotifications.forEach((item, idx) => {
        // مخزّنة مسبقاً وقت استقبال التعليق (addComment) — لا نعيد التقسيم والقياس هنا كل فريم
        const lines = item.cachedLines;
        const cardH = item.cardH;

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
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // الأفاتار دائماً يمين الكرت — موحّد لكل التعليقات بدون استثناء، يطابق dir="rtl" الأصلي
        const avatarCx = x + boxW - padX - avatarR;
        const avatarCy = renderTop + padY + 2 + avatarR;
        drawCircleImage(getImage(item.avatar), avatarCx, avatarCy, avatarR, "rgba(255,188,0,0.6)", 1);

        // النص دائماً يبدأ من يمين الأفاتار ويتدفق يساراً — نفس dir="rtl" الأصلي بدون أي كشف لغة
        const textRightEdge = x + boxW - padX - COMMENT_AVATAR_D - gapAvatarText;
        const textStartY = renderTop + padY + lineHeight * 0.78;
        item.cachedLines.forEach((pieces, i) => {
            drawMixedLine(pieces, textRightEdge, textStartY + i * lineHeight, lineHeight);
        });

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
    ctx.font = `700 20px ${FONT_BOLD}`; // كان 16px
    const textW = ctx.measureText(state.bubbleText).width;
    const boxW = textW + 56, boxH = 46; // كانت 40/36 — كبّرناها

    ctx.shadowColor = state.bubblePalette.border;
    ctx.shadowBlur = 10; // هالة خفيفة تزيد وضوح اللون
    ctx.fillStyle = state.bubblePalette.bg;
    roundRect(cx - boxW / 2, y - boxH / 2, boxW, boxH, 34);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = state.bubblePalette.border;
    ctx.lineWidth = 2; // كان 1
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.fillText(state.bubbleText, cx, y + 6);
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
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
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
    // في overlay.html الأصلي: <div>👤 viewers</div><div>❤️ likes</div>
    // مع dir="rtl"، العنصر الأول (viewers) يظهر على اليمين والثاني (likes) على يساره.
    // نحاكي هذا بتبديل ترتيب الرسم: likes أولاً (أقصى اليمين) ثم viewers بجانبه يساراً.
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
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    // ترتيب dir="rtl": ❤️ أقرب لليمين، ثم 👤 يساراً
    ctx.fillText(likesText, x + padX, y + boxH / 2 + 7);
    ctx.fillText(viewersText, x + padX + w2 + gap, y + boxH / 2 + 7);
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
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
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

    // ===== ١) الجزء العلوي: نفس بنر المتابعة بالضبط (شكل، أبعاد، تمدد حسب طول الاسم) =====
    // سطرين: "🎁 هدية: اسم الهدية" تسمية صغيرة فوق، واسم المُرسِل بسطر أكبر تحتها.
    const avatarR = 36, avatarD = avatarR * 2;
    const padX = 28;
    const gapTextAvatar = 20;
    const gapCountText = 28;
    const boxH = 100;

    ctx.font = `800 17px ${FONT_XBOLD}`;
    const giftLabel = `🎁 هدية: ${g.giftName}`;
    const labelW = ctx.measureText(giftLabel).width;
    ctx.font = `700 24px ${FONT_BOLD}`;
    const nameW = ctx.measureText(g.name).width;
    const textBlockW = Math.max(labelW, nameW); // سطرين فوق بعض، نفس المحاذاة

    const countText = `× ${g.count}`;
    ctx.font = `600 19px ${FONT_TEXT}`;
    const countTextW = ctx.measureText(countText).width;
    const cbW = countTextW + 36, cbH = 42;

    const contentW = padX + cbW + gapCountText + textBlockW + gapTextAvatar + avatarD + padX;
    const boxW = Math.max(320, contentW);
    const x = WIDTH / 2 - boxW / 2;
    const y = 160; // نفس موضع بنر الهدية القديم تقريباً، أعلى الشاشة فوق صورة الهدية الكبيرة

    ctx.fillStyle = "rgba(20,15,30,0.75)";
    roundRect(x, y, boxW, boxH, 50);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const avatarCx = x + boxW - padX - avatarR;
    const avatarCy = y + boxH / 2;
    drawCircleImage(getImage(g.avatar), avatarCx, avatarCy, avatarR, "#ffbc00", 3);

    const textRightEdge = avatarCx - avatarR - gapTextAvatar;
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffbc00";
    ctx.font = `800 17px ${FONT_XBOLD}`;
    ctx.fillText(giftLabel, textRightEdge, avatarCy - 12);

    ctx.fillStyle = "#ffffff";
    ctx.font = `700 24px ${FONT_BOLD}`;
    ctx.fillText(g.name, textRightEdge, avatarCy + 18);

    // عداد التكرار (بتأثير pop عند كل تحديث، نفس إحساس count-pop الأصلي)
    const bumpElapsed = Date.now() - (g.lastBumpAt || g.shownAt);
    const popScale = bumpElapsed < 150 ? 1 + 0.3 * (1 - bumpElapsed / 150) : 1;
    const cbX = x + padX, cbY = y + boxH / 2 - cbH / 2;
    ctx.save();
    ctx.translate(cbX + cbW / 2, cbY + cbH / 2);
    ctx.scale(popScale, popScale);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRectAt(-cbW / 2, -cbH / 2, cbW, cbH, 26);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffff00";
    ctx.font = `700 19px ${FONT_BOLD}`;
    ctx.fillText(countText, 0, 7);
    ctx.restore();

    // ===== ٢) أسفل البنر: صورة الهدية كبيرة وغير مقيدة بإطار، داخل صندوق شفاف بخواف مضيئة =====
    const giftImg = getImage(g.giftIcon);
    if (giftImg && giftImg.width) {
        // المقاس يتبع نسبة أبعاد الصورة الأصلية، بحد أقصى ~180px على الجهة الأطول
        // (قريب من ٢٠٠×٢٠٠ المطلوبة لكن مُعدَّل بالشكل المتوفر فوق بنر المتابعة بالأسفل)
        const MAX_DIM = 180;
        const ratio = giftImg.width / giftImg.height;
        let imgW, imgH;
        if (ratio >= 1) { imgW = MAX_DIM; imgH = MAX_DIM / ratio; }
        else { imgH = MAX_DIM; imgW = MAX_DIM * ratio; }

        const pad = 22; // مساحة أكبر بين الهالة والصورة عشان التوهج ما يلامس الصورة ويقلل وضوحها
        const boxImgW = imgW + pad * 2;
        const boxImgH = imgH + pad * 2;
        const cx = WIDTH / 2;
        const cy = y + boxH + 12 + boxImgH / 2; // مباشرة تحت بنر الاسم

        // الخفقة المضيئة حول الصندوق (هالة خفيفة فقط، بدون أي خط إطار ظاهر حول الصورة)
        const t = (Date.now() % 1400) / 1400;
        const glowPulse = 10 + 6 * Math.abs(Math.sin(t * Math.PI)); // كانت أقوى (18-32) فخففناها
        ctx.save();
        ctx.shadowColor = "rgba(255,188,0,0.35)"; // كانت 0.85 — خففنا الشفافية عشان ما تطغى على الصورة
        ctx.shadowBlur = glowPulse;
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        roundRectAt(cx - boxImgW / 2, cy - boxImgH / 2, boxImgW, boxImgH, 28);
        ctx.fill();
        ctx.restore();

        ctx.drawImage(giftImg, cx - imgW / 2, cy - imgH / 2, imgW, imgH);

        // جملة شكر فقط أسفل الصورة (اسم الهدية انتقل فوق جنب كلمة "هدية")
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 18px ${FONT_BOLD}`;
        ctx.fillText("🤍 جزاك الله خير", cx, cy + boxImgH / 2 + 22);
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
    const t = Math.min(1, elapsed / 400);
    const scale = 0.6 + 0.4 * (1 - Math.pow(1 - t, 3)); // ease-out أخف، بدون قفزة حجم كبيرة

    ctx.save();
    ctx.globalAlpha = 1;
    // إزالة تعتيم الشاشة الكامل القديم — يظهر الآن كبطاقة بسيطة بدون حجب باقي العناصر

    const boxW = 380, boxH = 110; // كانت 560×220 — صغّرناها حسب الطلب
    ctx.translate(WIDTH / 2, HEIGHT / 2);
    ctx.scale(scale, scale);

    // نفس لغة التصميم المستخدمة بباقي البنرات (غامق شفاف + حدّ ذهبي) بدل التدرّج الوردي/النيون القديم
    ctx.fillStyle = "rgba(20,15,30,0.85)";
    roundRectAt(-boxW / 2, -boxH / 2, boxW, boxH, 26);
    ctx.fill();
    ctx.strokeStyle = "#ffbc00";
    ctx.lineWidth = 2;
    ctx.shadowColor = "#ffbc00";
    ctx.shadowBlur = 10; // كانت 30
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 24px ${FONT_BOLD}`;
    ctx.fillText("تم تحقيق الهدف! 🎉", 0, -10);

    ctx.fillStyle = "#ffbc00";
    ctx.font = `700 17px ${FONT_BOLD}`;
    ctx.fillText(state.milestoneText, 0, 20);

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
    // اللوقو يُخفى تلقائياً وقت ظهور بنر الهدية (نفس شرط انتهاء الهدية المستخدم بالضبط بالأسفل)
    const giftActive = !!(state.gift && Date.now() <= state.giftHideAt);
    // drawLogo(); — محذوف حسب الطلب
    drawTasbih();             // z-index: 100
    drawClock();                // z-index: 100
    drawStats();                  // z-index: 100
    drawFollowBanner();              // z-index: 200
    drawGiftBanner();                  // z-index: 900
    drawMilestoneBanner();               // z-index: 1000 (الأعلى دائماً)

    return canvas.toBuffer("image/png");
}

function getDebugCounts() {
    return {
        bubbles: state.bubbleText ? 1 : 0,
        joins: state.joinNotifications.length,
        comments: state.commentNotifications.length,
        milestone: state.isMilestoneActive ? 1 : 0,
        gift: state.gift ? 1 : 0,
        follow: state.follow ? 1 : 0,
        imageCacheSize: imageCache.size,
    };
}

module.exports = {
    renderFrame,
    setViewerCount,
    setLikes,
    addJoin,
    addComment,
    setFollow,
    setGift,
    getDebugCounts,
};
