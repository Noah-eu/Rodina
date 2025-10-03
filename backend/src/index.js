require('dotenv').config();
require('dotenv').config();
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const https = require('https');
const { URL } = require('url');
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

const dbPath = path.join(__dirname, '..', 'db.json');
let dbData = null;

function readDB(){
  try{
    const raw = fs.readFileSync(dbPath, 'utf8');
    dbData = JSON.parse(raw);
  }catch(e){
    dbData = { users: [], messages: [], calls: [] };
    fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));
  }
}

function writeDB(){
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));
}

readDB();

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

// ensure uploads dir exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.post('/api/register', upload.single('avatar'), async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin || pin.length !== 4) return res.status(400).json({ error: 'Neplatný vstup' });
  readDB();
  const existing = dbData.users.find(u => u.name === name);
  if (existing) return res.status(400).json({ error: 'Uživatel již existuje' });
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(pin, salt);
  const id = nanoid();
  const avatar = req.file ? `/uploads/${req.file.filename}` : null;
  const user = { id, name, pinHash: hash, avatar, online: true };
  dbData.users.push(user);
  writeDB();
  res.json({ id, name, avatar });
});

app.post('/api/login', async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Neplatný vstup' });
  readDB();
  const user = dbData.users.find(u => u.name === name);
  if (!user) return res.status(404).json({ error: 'Uživatel nenalezen' });
  const match = await bcrypt.compare(pin, user.pinHash);
  if (!match) return res.status(401).json({ error: 'Špatný PIN' });
  user.online = true;
  writeDB();
  res.json({ id: user.id, name: user.name, avatar: user.avatar });
});

app.get('/api/users', async (req, res) => {
  readDB();
  res.json(dbData.users.map(u => ({ id: u.id, name: u.name, avatar: u.avatar, online: u.online })));
});

app.post('/api/message', async (req, res) => {
  const { from, text, type = 'text' } = req.body;
  if (!from || !text) return res.status(400).json({ error: 'Neplatný vstup' });
  readDB();
  const msg = { id: nanoid(), from, text, type, ts: Date.now() };
  dbData.messages.push(msg);
  writeDB();
  io.emit('message', msg);
  res.json(msg);
});

// ICE config fetcher (Xirsys)
app.get('/api/ice', async (req, res) => {
  try {
    const channel = (req.query.channel || process.env.XIRSYS_CHANNEL || 'default').toString();
    const region = (process.env.XIRSYS_REGION || 'global').toString();
    const username = process.env.XIRSYS_USERNAME || '';
    const secret = process.env.XIRSYS_SECRET || process.env.XIRSYS_API_KEY || '';
    const bearer = process.env.XIRSYS_BEARER || '';

    const endpoint = `https://${region}.xirsys.net/_turn/${encodeURIComponent(channel)}`;
    const url = new URL(endpoint);

    const headers = { 'User-Agent': 'Rodina/1.0', 'Accept': 'application/json' };
    if (bearer) {
      headers['Authorization'] = `Bearer ${bearer}`;
    } else if (username && secret) {
      const basic = Buffer.from(`${username}:${secret}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    } else {
      return res.status(500).json({ error: 'Xirsys credentials not configured. Set XIRSYS_BEARER or XIRSYS_USERNAME and XIRSYS_SECRET.' });
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
    res.status(500).json({ error: 'Failed to retrieve ICE config', details: e.message });
  }
});

io.on('connection', (socket) => {
  socket.on('registerSocket', (userId) => {
    socket.userId = userId;
    readDB();
    const user = dbData.users.find(u => u.id === userId);
    if (user) {
      user.online = true;
      writeDB();
      io.emit('presence', { id: user.id, online: true });
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      readDB();
      const user = dbData.users.find(u => u.id === socket.userId);
      if (user) {
        user.online = false;
        writeDB();
        io.emit('presence', { id: user.id, online: false });
      }
    }
  });

  socket.on('call', (callInfo) => {
    io.emit('incoming_call', callInfo);
  });
  // WebRTC signaling proxy
  socket.on('webrtc_offer', (data)=>{
    socket.broadcast.emit('webrtc_offer', data)
  })
  socket.on('webrtc_answer', (data)=>{
    socket.broadcast.emit('webrtc_answer', data)
  })
  socket.on('webrtc_ice', (data)=>{
    socket.broadcast.emit('webrtc_ice', data)
  })
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Backend běží na portu ${PORT}`));
} else {
  // for tests
  module.exports = app;
}
