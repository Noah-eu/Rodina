const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, '..', 'db.json');
const adapter = new JSONFile(dbPath);
const db = new Low(adapter);

async function initDB() {
  await db.read();
  db.data ||= { users: [], messages: [], calls: [] };
  await db.write();
}
initDB();

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

app.post('/api/register', upload.single('avatar'), async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin || pin.length !== 4) return res.status(400).json({ error: 'Neplatný vstup' });
  await db.read();
  const existing = db.data.users.find(u => u.name === name);
  if (existing) return res.status(400).json({ error: 'Uživatel již existuje' });
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(pin, salt);
  const id = nanoid();
  const avatar = req.file ? `/uploads/${req.file.filename}` : null;
  const user = { id, name, pinHash: hash, avatar, online: true };
  db.data.users.push(user);
  await db.write();
  res.json({ id, name, avatar });
});

app.post('/api/login', async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Neplatný vstup' });
  await db.read();
  const user = db.data.users.find(u => u.name === name);
  if (!user) return res.status(404).json({ error: 'Uživatel nenalezen' });
  const match = await bcrypt.compare(pin, user.pinHash);
  if (!match) return res.status(401).json({ error: 'Špatný PIN' });
  user.online = true;
  await db.write();
  res.json({ id: user.id, name: user.name, avatar: user.avatar });
});

app.get('/api/users', async (req, res) => {
  await db.read();
  res.json(db.data.users.map(u => ({ id: u.id, name: u.name, avatar: u.avatar, online: u.online })));
});

app.post('/api/message', async (req, res) => {
  const { from, text, type = 'text' } = req.body;
  if (!from || !text) return res.status(400).json({ error: 'Neplatný vstup' });
  await db.read();
  const msg = { id: nanoid(), from, text, type, ts: Date.now() };
  db.data.messages.push(msg);
  await db.write();
  io.emit('message', msg);
  res.json(msg);
});

io.on('connection', (socket) => {
  socket.on('registerSocket', async (userId) => {
    socket.userId = userId;
    await db.read();
    const user = db.data.users.find(u => u.id === userId);
    if (user) {
      user.online = true;
      await db.write();
      io.emit('presence', { id: user.id, online: true });
    }
  });

  socket.on('disconnect', async () => {
    if (socket.userId) {
      await db.read();
      const user = db.data.users.find(u => u.id === socket.userId);
      if (user) {
        user.online = false;
        await db.write();
        io.emit('presence', { id: user.id, online: false });
      }
    }
  });

  socket.on('call', (callInfo) => {
    io.emit('incoming_call', callInfo);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Backend běží na portu ${PORT}`));
