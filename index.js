require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const http = require('http');

// 1. Render uchun Mini-Server
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is running...");
}).listen(port, "0.0.0.0", () => {
    console.log(`📡 Mini-server ${port}-portda ishlamoqda`);
});

// 2. O'zgaruvchilarni tekshirish
if (!process.env.BOT_TOKEN || !process.env.MONGO_URI) {
    console.error("❌ XATO: BOT_TOKEN yoki MONGO_URI topilmadi!");
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// 3. MongoDB Sxemalari
const userSchema = new mongoose.Schema({ userId: Number, name: String });
const channelSchema = new mongoose.Schema({ 
    channelId: String, 
    link: String, 
    name: String,
    type: String 
});

const User = mongoose.model('User', userSchema);
const Channel = mongoose.model('Channel', channelSchema);

// MongoDB ulanishi
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB muvaffaqiyatli ulandi"))
    .catch(err => console.error("❌ Baza ulanishida xato:", err.message));

let adminState = {};

// 4. Yordamchi funksiyalar
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getUnsubscribedChannels(ctx) {
    const allChannels = await Channel.find();
    let unsubscribed = [];

    for (const ch of allChannels) {
        if (ch.type === 'telegram') {
            try {
                const member = await ctx.telegram.getChatMember(ch.channelId, ctx.from.id);
                const isMember = ['member', 'administrator', 'creator'].includes(member.status);
                if (!isMember) unsubscribed.push(ch);
            } catch (e) {
                unsubscribed.push(ch); 
            }
        } else {
            unsubscribed.push(ch); 
        }
    }
    return unsubscribed;
}

// 5. Start Buyrug'i
async function sendStart(ctx) {
    try {
        const userId = ctx.from.id;
        await User.findOneAndUpdate(
            { userId: userId }, 
            { name: ctx.from.first_name }, 
            { upsert: true }
        );

        if (userId === ADMIN_ID) {
            return ctx.reply("🛠 Admin Panelga xush kelibsiz:", Markup.keyboard([
                ['📊 Statistika', '📢 Xabar yuborish'],
                ['➕ Link qo\'shish', '🗑 Linklarni boshqarish']
            ]).resize());
        }

        const unsubbed = await getUnsubscribedChannels(ctx);

        if (unsubbed.length === 0) {
            return ctx.reply(`👋 Xush kelibsiz ${ctx.from.first_name}! Marhamat, kino kodini yuboring.`);
        } else {
            const buttons = unsubbed.map((l) => [Markup.button.url(l.name, l.link)]);
            buttons.push([Markup.button.callback("✅ Tekshirish", "check_sub")]);
            return ctx.reply("🔴 Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling:", Markup.inlineKeyboard(buttons));
        }
    } catch (e) { console.error("Start Error:", e); }
}

bot.start(sendStart);

// 6. Obunani tekshirish (Callback)
bot.action('check_sub', async (ctx) => {
    try {
        const unsubbed = await getUnsubscribedChannels(ctx);
        if (unsubbed.length === 0) {
            await ctx.editMessageText("✅ Rahmat! Obuna tasdiqlandi. Endi kod yuborishingiz mumkin.");
        } else {
            await ctx.answerCbQuery("❌ Ba'zi kanallarga hali obuna bo'lmagansiz!", { show_alert: true });
        }
    } catch (e) { console.error("Action error:", e); }
});

// 7. Admin Funksiyalari
bot.hears('📊 Statistika', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const totalUsers = await User.countDocuments();
    const totalLinks = await Channel.countDocuments();
    ctx.reply(`📊 Statistika:\n👤 Foydalanuvchilar: ${totalUsers}\n📢 Kanallar: ${totalLinks}`);
});

bot.hears('➕ Link qo\'shish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply("Turini tanlang:", Markup.inlineKeyboard([
        [Markup.button.callback("🔹 Telegram (ID)", "add_tg")],
        [Markup.button.callback("🔸 Tashqi link", "add_ext")]
    ]));
});

bot.action('add_tg', ctx => { adminState[ctx.from.id] = { step: 'tg_id' }; ctx.reply("Kanal ID raqamini yuboring (-100...):"); });
bot.action('add_ext', ctx => { adminState[ctx.from.id] = { step: 'ext_name' }; ctx.reply("Tugma nomini yuboring:"); });

bot.hears('🗑 Linklarni boshqarish', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const links = await Channel.find();
    if(links.length === 0) return ctx.reply("Linklar yo'q.");
    for (const l of links) {
        ctx.reply(`${l.name}\n${l.link}`, Markup.inlineKeyboard([[Markup.button.callback("❌ O'chirish", `del_${l._id}`)]]));
    }
});

bot.action(/^del_(.+)$/, async (ctx) => {
    await Channel.findByIdAndDelete(ctx.match[1]);
    ctx.answerCbQuery("O'chirildi!");
    ctx.editMessageText("🗑 Link o'chirildi.");
});

bot.hears('📢 Xabar yuborish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    adminState[ctx.from.id] = { step: 'ad_content' };
    ctx.reply("Reklama postini (rasm, video yoki matn) yuboring:");
});

// 8. Xabarlarni qayta ishlash
bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    if (userId === ADMIN_ID && adminState[userId]) {
        let state = adminState[userId];
        if (state.step === 'tg_id') { adminState[userId] = { step: 'tg_link', id: text }; return ctx.reply("Linkni yuboring (https://t.me/...):"); }
        if (state.step === 'tg_link') { 
            await new Channel({ channelId: state.id, link: text, name: "📢 Kanal", type: 'telegram' }).save(); 
            delete adminState[userId]; return ctx.reply("✅ Kanal saqlandi!"); 
        }
        if (state.step === 'ext_name') { adminState[userId] = { step: 'ext_link', name: text }; return ctx.reply("Linkni yuboring:"); }
        if (state.step === 'ext_link') { 
            await new Channel({ channelId: 'none', link: text, name: state.name, type: 'external' }).save(); 
            delete adminState[userId]; return ctx.reply("✅ Tashqi link saqlandi!"); 
        }
        
        if (state.step === 'ad_content') {
            adminState[userId] = { step: 'ad_btn', msgId: ctx.message.message_id };
            return ctx.reply("Tugma qo'shilsinmi?", Markup.inlineKeyboard([[Markup.button.callback("✅ Ha", "btn_yes"), Markup.button.callback("❌ Yo'q", "btn_no")]]));
        }
        if (state.step === 'ad_btn_data') {
            const d = text.split('|');
            if (d.length < 2) return ctx.reply("Format xato! Nomi | Link");
            broadcast(ctx, state.msgId, Markup.inlineKeyboard([[Markup.button.url(d[0].trim(), d[1].trim())]]));
            delete adminState[userId]; return;
        }
    }

    if (text && !text.startsWith('/')) {
        const unsubbed = await getUnsubscribedChannels(ctx);
        if (unsubbed.length > 0) {
            const buttons = unsubbed.map((l) => [Markup.button.url(l.name, l.link)]);
            buttons.push([Markup.button.callback("✅ Tekshirish", "check_sub")]);
            return ctx.reply("⚠️ Botdan foydalanish uchun kanallarga obuna bo'ling:", Markup.inlineKeyboard(buttons));
        }
        ctx.reply(`✅ Kod: ${text}. Kino bazadan qidirilmoqda...`);
    }
});

// 9. Reklama Funksiyasi
async function broadcast(ctx, msgId, kb = null) {
    const users = await User.find();
    ctx.reply(`🚀 ${users.length} kishiga yuborish boshlandi...`);
    let count = 0; let blocked = 0;

    for (const u of users) {
        try { 
            await ctx.telegram.copyMessage(u.userId, ctx.from.id, msgId, kb); 
            count++;
            if (count % 25 === 0) await sleep(1000); 
        } catch (e) {
            if (e.response && e.response.error_code === 403) blocked++;
        }
    }
    ctx.reply(`✅ Tugatildi!\n✅ Yetkazildi: ${count}\n❌ Bloklagan: ${blocked}`);
}

bot.action('btn_yes', ctx => { adminState[ctx.from.id].step = 'ad_btn_data'; ctx.reply("Format: `Nomi | Link`", { parse_mode: 'Markdown' }); });
bot.action('btn_no', ctx => { 
    if(adminState[ctx.from.id]) {
        broadcast(ctx, adminState[ctx.from.id].msgId); 
        delete adminState[ctx.from.id];
    }
});

// 10. Global Xatolarni boshqarish
bot.catch((err) => {
    console.error("🔴 Global xato:", err.message);
});

// Botni ishga tushirish (async/await ishlatilmadi, .then ishlatildi)
bot.launch()
    .then(() => console.log("🚀 Bot muvaffaqiyatli ishga tushdi!"))
    .catch((err) => console.error("❌ Bot ishga tushmadi:", err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
