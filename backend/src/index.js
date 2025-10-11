require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
// Also try loading .env from repo root (two levels up) when running from backend folder
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') }); } catch (e) {}
const multer = require('multer');
const https = require('https');
const { URL } = require('url');
const Pusher = require('pusher');
const webpush = require('web-push');
// jednoduchá DB přes soubor (vyhneme se ESM-only lowdb kvůli testům)
// místo ESM-only nanoid použijeme jednoduchý CJS id generator
function nanoid(len = 10){
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for(let i=0;i<len;i++) id += chars[Math.floor(Math.random()*chars.length)];
  return id + Date.now().toString(36);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
// uploads directory configurable (e.g., Render persistent disk)
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(uploadsDir))

// Data dir (use persistent disk if configured)
// Prefer DATA_DIR; fallback to uploadsDir; avoid unwritable /data on Render
let dataDir = process.env.DATA_DIR || uploadsDir;
try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
} catch (e) {
  // Fallback to uploadsDir if creating DATA_DIR fails
  dataDir = uploadsDir;
  try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch(_){}
}
try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
const dbPath = path.join(dataDir, 'db.json');
let dbData = null;

function readDB(){
  try{
    const raw = fs.readFileSync(dbPath, 'utf8');
    dbData = JSON.parse(raw);
  }catch(e){
    dbData = { users: [], messages: [], calls: [], pushSubscriptions: [] };
    fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));
  }
}

function writeDB(){
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));
}

readDB();

// ensure uploads dir exists
try { if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true }); } catch(e) {}

const upload = multer({ dest: uploadsDir });

// Pusher setup (server-side)
const pusherEnabled = Boolean(process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER);
const pusher = pusherEnabled ? new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
}) : null;

function broadcast(event, payload){
  // Socket.IO (lokální dev)
  try{ io.emit(event, payload); }catch(e){}
  // Pusher (produkce)
  if (pusher) {
    pusher.trigger('famcall', event, payload).catch(()=>{})
  }
}

// Web Push (VAPID)
const vapidPath = path.join(dataDir, 'vapid.json');
function ensureVapid(){
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_EMAIL || 'mailto:david.eder78@gmail.com';
  if (!pub || !priv){
    try{
      if (fs.existsSync(vapidPath)){
        const saved = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
        pub = saved.publicKey; priv = saved.privateKey;
      } else {
        const keys = webpush.generateVAPIDKeys();
        pub = keys.publicKey; priv = keys.privateKey;
        fs.writeFileSync(vapidPath, JSON.stringify(keys, null, 2));
      }
    }catch(e){}
  }
  if (pub && priv){
    webpush.setVapidDetails(contact, pub, priv);
  }
}
ensureVapid();

app.post('/api/register', upload.single('avatar'), async (req, res) => {
  const { name, pin } = req.body;
  console.log('[REGISTER] vstup:', { name, pin });
  if (!name || !pin || pin.length !== 4) {
    console.log('[REGISTER] Neplatný vstup');
    return res.status(400).json({ error: 'Neplatný vstup' });
  }
  readDB();
  const norm = String(name).trim().toLowerCase();
  const existing = dbData.users.find(u => (u.nameNorm || (u.name||'').toLowerCase()) === norm);
  if (existing) {
    console.log('[REGISTER] Uživatel již existuje:', existing);
    return res.status(400).json({ error: 'Uživatel již existuje' });
  }
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(pin, salt);
  const id = nanoid();
  const avatar = req.file ? `/uploads/${req.file.filename}` : null;
  const user = { id, name, nameNorm: norm, pinHash: hash, avatar, online: true };
  dbData.users.push(user);
  writeDB();
  console.log('[REGISTER] Uživatel uložen:', user);
  broadcast('presence', { id, online: true });
  res.json({ id, name, avatar });
});

app.post('/api/login', async (req, res) => {
  const { id, name, pin } = req.body || {};
  console.log('[LOGIN] vstup:', { id, name, pin });
  if ((!name && !id) || !pin) {
    console.log('[LOGIN] Neplatný vstup');
    return res.status(400).json({ error: 'Neplatný vstup' });
  }
  readDB();
  let user = null;
  if (id) {
    user = dbData.users.find(u => u.id === id);
    console.log('[LOGIN] Hledám podle ID:', id, 'Nalezen:', user);
  }
  // Pokud není user podle ID, nebo není ID, zkusíme podle jména (case-insensitive)
  if (!user && name) {
    const norm = String(name).trim().toLowerCase();
    user = dbData.users.find(u => (u.nameNorm || (u.name||'').toLowerCase()) === norm);
    console.log('[LOGIN] Hledám podle jména:', norm, 'Nalezen:', user);
  }
  if (!user) {
    console.log('[LOGIN] Uživatel nenalezen');
    return res.status(404).json({ error: 'Uživatel nenalezen' });
  }
  const match = await bcrypt.compare(pin, user.pinHash);
  if (!match) {
    console.log('[LOGIN] Špatný PIN');
    return res.status(401).json({ error: 'Špatný PIN' });
  }
  user.online = true;
  writeDB();
  console.log('[LOGIN] Přihlášení OK:', user);
  broadcast('presence', { id: user.id, online: true });
  res.json({ id: user.id, name: user.name, avatar: user.avatar });
});

app.get('/api/users', async (req, res) => {
  readDB();
  res.json(dbData.users.map(u => ({ id: u.id, name: u.name, avatar: u.avatar, online: u.online })));
});

// Return ICE config (used as fallback if Netlify function is not available)
// (removed duplicate simple /api/ice here; see unified Xirsys-enabled version below with STUN fallback)

// Zprávy: text i přílohy (foto/video/audio)
app.post('/api/message', upload.single('file'), async (req, res) => {
  const isMultipart = req.is('multipart/form-data');
  const from = isMultipart ? (req.body?.from) : req.body?.from;
  const to = isMultipart ? (req.body?.to) : req.body?.to;
  if (!from) return res.status(400).json({ error: 'Neplatný vstup: chybí odesílatel' });

  let msg = { id: nanoid(), from, to: to || null, ts: Date.now() };

  if (isMultipart && req.file){
    // Příloha
    if (req.file.size === 0) {
      // Smazat prázdný soubor, pokud vznikl
      try { fs.unlinkSync(req.file.path); } catch(e){}
      return res.status(400).json({ error: 'Prázdný soubor, hlasovka nebyla uložena.' });
    }
    const mime = req.file.mimetype || '';
    const url = `/uploads/${req.file.filename}`;
    if (mime.startsWith('image/')){ msg.type = 'image'; msg.url = url; }
    else if (mime.startsWith('video/')){ msg.type = 'video'; msg.url = url; }
    else if (mime.startsWith('audio/')){ msg.type = 'audio'; msg.url = url; }
    else { msg.type = 'file'; msg.url = url; msg.name = req.file.originalname; }
    msg.text = req.body?.text || '';
  } else {
    // Čistě textová zpráva
    const { text, type = 'text' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Neplatný vstup: chybí text' });
    msg = { ...msg, text, type };
  }

  readDB();
  dbData.messages.push(msg);
  writeDB();
  broadcast('message', msg);

  // Push oznámení
  const subs = Array.isArray(dbData.pushSubscriptions) ? dbData.pushSubscriptions : [];
  const body = msg.type==='text' && msg.text ? msg.text
    : msg.type==='image' ? 'Poslal(a) fotku'
    : msg.type==='video' ? 'Poslal(a) video'
    : msg.type==='audio' ? 'Poslal(a) hlasovou zprávu'
    : 'Nová zpráva';
  for (const sub of subs){
    try{ await webpush.sendNotification(sub, JSON.stringify({ title: 'Rodina', body })) }catch(e){}
  }
  res.json(msg);
});

// Seznam zpráv (posledních N)
app.get('/api/messages', (req, res)=>{
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit||'100',10)));
  const me = req.query.me?.toString();
  const peer = req.query.peer?.toString();
  readDB();
  let all = dbData.messages || [];
  if (me && peer){
    all = all.filter(m => (m.from===me && m.to===peer) || (m.from===peer && m.to===me));
  }
  const slice = all.slice(-limit);
  res.json(slice);
})

// Presence update endpoint (explicit)
app.post('/api/presence', (req, res)=>{
  const { id, online } = req.body || {};
  if(!id) return res.status(400).json({ error: 'Missing id' });
  readDB();
  const u = dbData.users.find(x=>x.id===id);
  if(!u) return res.status(404).json({ error: 'Not found' });
  u.online = Boolean(online);
  writeDB();
  broadcast('presence', { id: u.id, online: u.online });
  res.json({ ok: true });
});

// ICE config fetcher (Xirsys)
app.get('/api/ice', async (req, res) => {
  try {
    const channel = (req.query.channel || process.env.XIRSYS_CHANNEL || 'default').toString();
    const region = (process.env.XIRSYS_REGION || 'global').toString();
    const username = process.env.XIRSYS_USERNAME || '';
    const secret = process.env.XIRSYS_SECRET || process.env.XIRSYS_API_KEY || '';
    const bearer = process.env.XIRSYS_BEARER || '';

    // If no Xirsys credentials configured, provide STUN-only fallback
    if (!bearer && !(username && secret)) {
      return res.json({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] });
    }

    const endpoint = `https://${region}.xirsys.net/_turn/${encodeURIComponent(channel)}`;
    const url = new URL(endpoint);

    const headers = { 'User-Agent': 'Rodina/1.0', 'Accept': 'application/json' };
    if (bearer) {
      headers['Authorization'] = `Bearer ${bearer}`;
    } else if (username && secret) {
      const basic = Buffer.from(`${username}:${secret}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }

    const options = {
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      headers
    };

    const fetchJson = () => new Promise((resolve, reject) => {
      const reqHttps = https.request(options, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          try {
            const json = JSON.parse(data || '{}');
            resolve({ status: r.statusCode || 0, json });
          } catch (e) { reject(e); }
        });
      });
      reqHttps.on('error', reject);
      reqHttps.end();
    });

    const { status, json } = await fetchJson();
    if (status < 200 || status >= 300) {
      return res.status(status || 502).json({ error: 'Xirsys request failed', details: json });
    }
    // Normalize various Xirsys response shapes
    const iceServers = (json && (json.v?.iceServers || json.iceServers || json.d?.iceServers)) || [];
    if (!Array.isArray(iceServers)) {
      return res.status(502).json({ error: 'Invalid Xirsys response', details: json });
    }
    res.json({ iceServers });
  } catch (e) {
    // On any error, fallback to STUN so basic connectivity still works
    try { return res.json({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] }); } catch(_) {}
    res.status(500).json({ error: 'Failed to retrieve ICE config', details: e.message });
  }
});

// Signaling REST endpoints (for Pusher triggers from clients)
app.post('/api/rt/offer', (req, res)=>{ const payload = req.body || {}; broadcast('webrtc_offer', payload); res.json({ ok: true }) })
app.post('/api/rt/answer', (req, res)=>{ const payload = req.body || {}; broadcast('webrtc_answer', payload); res.json({ ok: true }) })
app.post('/api/rt/ice', (req, res)=>{ const payload = req.body || {}; broadcast('webrtc_ice', payload); res.json({ ok: true }) })
app.post('/api/rt/typing', (req, res)=>{ const payload = req.body || {}; broadcast('typing', payload); res.json({ ok: true }) })
app.post('/api/rt/delivered', (req, res)=>{ const payload = req.body || {}; broadcast('delivered', payload); res.json({ ok: true }) })
app.post('/api/call', async (req, res)=>{
  const info = req.body || {};
  broadcast('incoming_call', info);
  // Push oznámení o příchozím hovoru
  readDB();
  const subs = Array.isArray(dbData.pushSubscriptions) ? dbData.pushSubscriptions : [];
  for (const sub of subs){
    try{ await webpush.sendNotification(sub, JSON.stringify({ title: 'Rodina', body: 'Příchozí hovor' })) }catch(e){}
  }
  res.json({ ok: true })
})

// Web Push: get VAPID public key and subscribe
app.get('/api/push/publicKey', (req, res)=>{
  try{
    const saved = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
    return res.json({ publicKey: saved.publicKey })
  }catch(e){ return res.status(404).json({ error: 'No VAPID key' }) }
})
app.post('/api/push/subscribe', (req, res)=>{
  const subscription = req.body;
  if(!subscription) return res.status(400).json({ error: 'Missing subscription' });
  readDB();
  dbData.pushSubscriptions = Array.isArray(dbData.pushSubscriptions) ? dbData.pushSubscriptions : [];
  const exists = dbData.pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
  if(!exists) dbData.pushSubscriptions.push(subscription);
  writeDB();
  res.json({ ok: true });
})

io.on('connection', (socket) => {
  socket.on('registerSocket', (userId) => {
    socket.userId = userId;
    readDB();
    const user = dbData.users.find(u => u.id === userId);
    if (user) {
      user.online = true;
      writeDB();
  broadcast('presence', { id: user.id, online: true });
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      readDB();
      const user = dbData.users.find(u => u.id === socket.userId);
      if (user) {
        user.online = false;
        writeDB();
  broadcast('presence', { id: user.id, online: false });
      }
    }
  });

  socket.on('call', (callInfo) => {
    broadcast('incoming_call', callInfo);
  });
  // WebRTC signaling proxy
  socket.on('webrtc_offer', (data)=>{
    socket.broadcast.emit('webrtc_offer', data); broadcast('webrtc_offer', data)
  })
  socket.on('webrtc_answer', (data)=>{
    socket.broadcast.emit('webrtc_answer', data); broadcast('webrtc_answer', data)
  })
  socket.on('webrtc_ice', (data)=>{
    socket.broadcast.emit('webrtc_ice', data); broadcast('webrtc_ice', data)
  })
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Backend běží na portu ${PORT}`));
} else {
  // for tests
  module.exports = app;
}
