require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const http = require('http');

// 1. Hosting uchun Mini-Server (Render uchun optimallashtirilgan)
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot ishlamoqda...");
}).listen(process.env.PORT || 3000);

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// 2. MongoDB Sxemalari
const userSchema = new mongoose.Schema({ userId: Number, name: String });
const channelSchema = new mongoose.Schema({ 
    channelId: String, 
    link: String, 
    name: String,
    type: String 
});

const User = mongoose.model('User', userSchema);
const Channel = mongoose.model('Channel', channelSchema);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB muvaffaqiyatli ulandi"))
    .catch(err => console.error("❌ Baza xatosi:", err));

let adminState = {};

// 3. Obuna bo'linmagan kanallarni aniqlash funksiyasi
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
                // Agar bot kanalga admin bo'lmasa yoki xato bo'lsa
                unsubscribed.push(ch); 
            }
        } else {
            unsubscribed.push(ch);
        }
    }
    return unsubscribed;
}

// 4. Start Buyrug'i
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
            return ctx.reply("👋 Xush kelibsiz! Marhamat, kino kodini yuboring.");
        } else {
            const buttons = unsubbed.map((l) => [Markup.button.url(l.name, l.link)]);
            buttons.push([Markup.button.callback("✅ Tekshirish", "check_sub")]);
            return ctx.reply("🔴 Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling:", Markup.inlineKeyboard(buttons));
        }
    } catch (e) { console.error("Start Error:", e); }
}

bot.start(sendStart);

// 5. Obunani tekshirish tugmasi
bot.action('check_sub', async (ctx) => {
    try {
        const unsubbed = await getUnsubscribedChannels(ctx);
        if (unsubbed.length === 0) {
            await ctx.editMessageText("✅ Rahmat! Obuna tasdiqlandi. Endi kod yuborishingiz mumkin.");
        } else {
            await ctx.answerCbQuery("❌ Ba'zi kanallarga hali obuna bo'lmagansiz!", { show_alert: true });
            const buttons = unsubbed.map((l) => [Markup.button.url(l.name, l.link)]);
            buttons.push([Markup.button.callback("✅ Tekshirish", "check_sub")]);
            try {
                await ctx.editMessageText("⚠️ Iltimos, ushbu kanallarga ham obuna bo'ling:", Markup.inlineKeyboard(buttons));
            } catch (err) {}
        }
    } catch (e) { console.error("Action error:", e); }
});

// 6. Admin: Statistika
bot.hears('📊 Statistika', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const totalUsers = await User.countDocuments();
        const totalLinks = await Channel.countDocuments();
        ctx.reply(`📊 Bot statistikasi:\n\n👤 Foydalanuvchilar: ${totalUsers} ta\n📢 Kanallar: ${totalLinks} ta`);
    } catch (e) { ctx.reply("Statistika yuklashda xato!"); }
});

// 7. Admin: Linklarni boshqarish
bot.hears('➕ Link qo\'shish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply("Turini tanlang:", Markup.inlineKeyboard([
        [Markup.button.callback("🔹 Telegram (ID orqali)", "add_tg")],
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

// 8. Admin: Reklama
bot.hears('📢 Xabar yuborish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    adminState[ctx.from.id] = { step: 'ad_content' };
    ctx.reply("Reklama postini yuboring:");
});

// 9. Xabarlarni qayta ishlash
bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    if (userId === ADMIN_ID && adminState[userId]) {
        let state = adminState[userId];
        if (state.step === 'tg_id') { adminState[userId] = { step: 'tg_link', id: text }; return ctx.reply("Linkni yuboring:"); }
        if (state.step === 'tg_link') { await new Channel({ channelId: state.id, link: text, name: "📢 Kanal", type: 'telegram' }).save(); delete adminState[userId]; return ctx.reply("✅ Saqlandi!"); }
        if (state.step === 'ext_name') { adminState[userId] = { step: 'ext_link', name: text }; return ctx.reply("Linkni yuboring:"); }
        if (state.step === 'ext_link') { await new Channel({ channelId: 'none', link: text, name: state.name, type: 'external' }).save(); delete adminState[userId]; return ctx.reply("✅ Saqlandi!"); }
        
        if (state.step === 'ad_content') {
            adminState[userId] = { step: 'ad_btn', msgId: ctx.message.message_id };
            return ctx.reply("Tugma qo'shilsinmi?", Markup.inlineKeyboard([[Markup.button.callback("✅ Ha", "btn_yes"), Markup.button.callback("❌ Yo'q", "btn_no")]]));
        }
        if (state.step === 'ad_btn_data') {
            const d = text.split('|');
            if (d.length < 2) return ctx.reply("Format: Nomi | Link");
            broadcast(ctx, state.msgId, Markup.inlineKeyboard([[Markup.button.url(d[0].trim(), d[1].trim())]]));
            delete adminState[userId]; return;
        }
    }

    if (text && !text.startsWith('/')) {
        const unsubbed = await getUnsubscribedChannels(ctx);
        if (unsubbed.length > 0) {
            const buttons = unsubbed.map((l) => [Markup.button.url(l.name, l.link)]);
            buttons.push([Markup.button.callback("✅ Tekshirish", "check_sub")]);
            return ctx.reply("⚠️ Botdan foydalanish uchun avval quyidagi kanallarga obuna bo'ling:", Markup.inlineKeyboard(buttons));
        }
        ctx.reply(`✅ Kod qabul qilindi: ${text}. Kino qidirilmoqda...`);
    }
});

// 10. Reklama funksiyasi (Bloklanganlarni chetlab o'tish bilan)
async function broadcast(ctx, msgId, kb = null) {
    const users = await User.find();
    ctx.reply(`🚀 ${users.length} kishiga yuborish boshlandi...`);
    let count = 0;
    let blocked = 0;

    for (const u of users) {
        try { 
            await ctx.telegram.copyMessage(u.userId, ctx.from.id, msgId, kb); 
            count++;
        } catch (e) {
            // Agar foydalanuvchi botni bloklagan bo'lsa (Error 403)
            if (e.response && e.response.error_code === 403) {
                blocked++;
                // Ixtiyoriy: bloklagan foydalanuvchini bazadan o'chirib yuborish
                // await User.deleteOne({ userId: u.userId });
            }
        }
    }
    ctx.reply(`✅ Tugatildi!\n✅ Yetkazildi: ${count} ta\n❌ Bloklagan: ${blocked} ta`);
}

bot.action('btn_yes', ctx => { adminState[ctx.from.id].step = 'ad_btn_data'; ctx.reply("Format: `Nomi | Link`", { parse_mode: 'Markdown' }); });
bot.action('btn_no', ctx => { 
    if(adminState[ctx.from.id]) {
        broadcast(ctx, adminState[ctx.from.id].msgId); 
        delete adminState[ctx.from.id];
    }
});

// 11. Global Xatolarni ushlash (Bot o'chib qolmasligi uchun eng muhim qism)
bot.catch((err, ctx) => {
    console.error(`🔴 Xatolik yuz berdi (${ctx.update_type}):`, err);
    // Render-da bot o'chib qolmasligi uchun xatolarni shunchaki log qilamiz
    if (err.response && err.response.error_code === 403) {
        return; // Foydalanuvchi bloklagan bo'lsa hech nima qilma
    }
});

bot.launch().then(() => console.log("🚀 Bot ishga tushdi!"));

// To'g'ri to'xtatish (Sigterm/Sigint)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
