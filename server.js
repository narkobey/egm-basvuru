const express      = require('express');
const session      = require('express-session');
const fetch        = require('node-fetch');
const path         = require('path');
const fs           = require('fs');

const app = express();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  REDIRECT_URI,
  PORT           = 3000,
  SESSION_SECRET = 'pomem_gizli_2026',
  ADMIN_PASSWORD = 'admin123',
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
} = process.env;

const DISCORD_API = 'https://discord.com/api/v10';
const DB_FILE     = path.join(__dirname, 'data', 'db.json');

// ── Veritabanı
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { basvurular: [], nextId: 1 };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return { basvurular: [], nextId: 1 }; }
}
function writeDB(db) {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ── Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname)));

// ════════════════════════════
//  AUTH
// ════════════════════════════
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=1');
  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=1');

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    if (!user.id) return res.redirect('/?error=1');

    req.session.user = {
      id:          user.id,
      username:    user.username,
      global_name: user.global_name || user.username,
      avatar:      user.avatar || null,
    };
    res.redirect('/');
  } catch (e) {
    console.error('OAuth hata:', e);
    res.redirect('/?error=1');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ════════════════════════════
//  API – Kullanıcı
// ════════════════════════════
app.get('/api/me', (req, res) => {
  req.session.user
    ? res.json({ loggedIn: true, user: req.session.user })
    : res.json({ loggedIn: false });
});

// ════════════════════════════
//  API – Başvuru
// ════════════════════════════
app.post('/api/basvuru', async (req, res) => {
  if (!req.session.user) return res.json({ success: false, message: 'Giriş yapmanız gerekiyor.' });
  const db   = readDB();
  const user = req.session.user;
  if (db.basvurular.find(b => b.discord_id === user.id))
    return res.json({ success: false, message: 'Zaten bir başvurunuz mevcut.' });

  const { yanitlar } = req.body;
  if (!yanitlar || typeof yanitlar !== 'object')
    return res.json({ success: false, message: 'Geçersiz form verisi.' });

  const id = db.nextId++;
  const basvuru = {
    id,
    discord_id:  user.id,
    username:    user.username,
    global_name: user.global_name,
    avatar:      user.avatar,
    yanitlar,
    durum:       'beklemede',
    inceleyen:   '',
    notlar:      '',
    tarih:       new Date().toLocaleString('tr-TR'),
  };
  db.basvurular.push(basvuru);
  writeDB(db);
  sendChannelNotification(basvuru).catch(console.error);
  res.json({ success: true, id });
});

app.get('/api/basvuru', (req, res) => {
  if (!req.session.user) return res.json({ success: false, message: 'Giriş yapmanız gerekiyor.' });
  const db = readDB();
  const b  = db.basvurular.find(b => b.discord_id === req.session.user.id);
  b ? res.json({ success: true, data: b })
    : res.json({ success: false, message: 'Başvuru bulunamadı.' });
});

// ════════════════════════════
//  API – Admin
// ════════════════════════════
app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Hatalı şifre.' });
  }
});

app.get('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

app.get('/api/admin/basvurular', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  const db   = readDB();
  const list = db.basvurular.map(({ yanitlar, notlar, ...rest }) => rest);
  res.json({ success: true, data: list });
});

app.get('/api/admin/basvuru/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  const db = readDB();
  const b  = db.basvurular.find(b => b.id === Number(req.params.id));
  b ? res.json({ success: true, data: b })
    : res.json({ success: false, message: 'Bulunamadı.' });
});

app.post('/api/admin/basvuru/:id/guncelle', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  const db  = readDB();
  const idx = db.basvurular.findIndex(b => b.id === Number(req.params.id));
  if (idx === -1) return res.json({ success: false, message: 'Bulunamadı.' });

  const eskiDurum = db.basvurular[idx].durum;
  const { durum, inceleyen, notlar } = req.body;
  if (durum)     db.basvurular[idx].durum     = durum;
  if (inceleyen !== undefined) db.basvurular[idx].inceleyen = inceleyen;
  if (notlar    !== undefined) db.basvurular[idx].notlar    = notlar;
  writeDB(db);

  if (durum && durum !== eskiDurum)
    sendDM(db.basvurular[idx]).catch(console.error);

  res.json({ success: true });
});

app.delete('/api/admin/basvuru/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  const db  = readDB();
  const idx = db.basvurular.findIndex(b => b.id === Number(req.params.id));
  if (idx === -1) return res.json({ success: false });
  db.basvurular.splice(idx, 1);
  writeDB(db);
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ════════════════════════════
//  Discord Bildirimler
// ════════════════════════════
async function sendChannelNotification(b) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) return;
  await fetch(`${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({
      embeds: [{
        title:       `📋 Yeni Başvuru #${b.id}`,
        color:       0x5865F2,
        description: `**${b.global_name || b.username}** (@${b.username}) başvurdu.`,
        fields: [
          { name: 'Discord ID', value: b.discord_id, inline: true },
          { name: 'Tarih',      value: b.tarih,       inline: true },
          { name: 'Durum',      value: '⏳ Beklemede', inline: true },
        ],
        footer:    { text: 'POMEM Başvuru Sistemi' },
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

async function sendDM(b) {
  if (!DISCORD_BOT_TOKEN) return;
  const durum = b.durum;
  const mesaj = durum === 'onaylandi'
    ? '✅ **Başvurunuz onaylandı!** Tebrikler, POMEM\'e kabul edildiniz.'
    : durum === 'reddedildi'
    ? '❌ **Başvurunuz reddedildi.** Maalesef bu sefer kabul edilmediniz.'
    : `⏳ Başvurunuzun durumu güncellendi: **${durum}**`;

  const dm = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    body:    JSON.stringify({ recipient_id: b.discord_id }),
  }).then(r => r.json());

  if (!dm.id) return;

  await fetch(`${DISCORD_API}/channels/${dm.id}/messages`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    body:    JSON.stringify({
      embeds: [{
        title:       'POMEM Başvuru Sonucu',
        color:       durum === 'onaylandi' ? 0x48bb78 : durum === 'reddedildi' ? 0xfc8181 : 0xf6ad55,
        description: mesaj,
        footer:      { text: `Başvuru #${b.id} • POMEM Başvuru Sistemi` },
        timestamp:   new Date().toISOString(),
      }],
    }),
  });
}

// ════════════════════════════
//  Başlat
// ════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ Sunucu: http://localhost:${PORT}`);
});
