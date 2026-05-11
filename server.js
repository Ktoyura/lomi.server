const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// CORS for HTTP routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'lomi_secret_key_2026';
const MONGO_URI = process.env.MONGO_URI || '';

// ── MongoDB ───────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(e => console.error('MongoDB error:', e));

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, minlength: 2, maxlength: 16 },
  password: { type: String, required: true },
  points:   { type: Number, default: 0 },
  stats: {
    totalGames: { type: Number, default: 0 },
    totalWins:  { type: Number, default: 0 },
    winStreak:  { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    botWins:    { type: Number, default: 0 },
    hardBotWins:{ type: Number, default: 0 },
    totalWalls: { type: Number, default: 0 },
  },
  unlockedAch: { type: [String], default: [] },
  equippedPiece: { type: String, default: 'default' },
  equippedWall:  { type: String, default: 'default' },
  ownedItems:    { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);

// ── Auth middleware ───────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недействителен' });
  }
}

// ── Auth routes ───────────────────────────────────────────────────
// Register
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполни все поля' });
    if (username.length < 2 || username.length > 16) return res.status(400).json({ error: 'Имя: 2–16 символов' });
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]+$/.test(username)) return res.status(400).json({ error: 'Только буквы, цифры и _' });
    if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

    const exists = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (exists) return res.status(409).json({ error: 'Имя уже занято' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, user: sanitize(user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, user: sanitize(user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Get profile
app.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(sanitize(user));
  } catch {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Save progress
app.post('/progress', authMiddleware, async (req, res) => {
  try {
    const { points, stats, unlockedAch, equippedPiece, equippedWall, ownedItems } = req.body;
    await User.findByIdAndUpdate(req.user.id, {
      $set: { points, stats, unlockedAch, equippedPiece, equippedWall, ownedItems }
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// Leaderboard
app.get('/leaderboard', async (req, res) => {
  try {
    const top = await User.find({}, 'username points stats.totalWins stats.totalGames')
      .sort({ points: -1 }).limit(20);
    res.json(top.map(u => ({
      username: u.username,
      points: u.points,
      wins: u.stats.totalWins,
      games: u.stats.totalGames,
    })));
  } catch {
    res.status(500).json({ error: 'Ошибка' });
  }
});

function sanitize(u) {
  return {
    username: u.username,
    points: u.points,
    stats: u.stats,
    unlockedAch: u.unlockedAch,
    equippedPiece: u.equippedPiece,
    equippedWall: u.equippedWall,
    ownedItems: u.ownedItems,
  };
}

// ── Socket.io rooms (same as before) ─────────────────────────────
const rooms = {};

function makeCode() { return Math.random().toString(36).substring(2,8).toUpperCase(); }
function makeRoom(code) { return { code, players:[], started:false, createdAt:Date.now() }; }

setInterval(()=>{ const now=Date.now(); for(const c in rooms) if(now-rooms[c].createdAt>3600000) delete rooms[c]; },600000);

io.on('connection', socket => {
  socket.on('create_room', ({username}) => {
    let code=makeCode(); while(rooms[code]) code=makeCode();
    const room=makeRoom(code); room.players.push({id:socket.id,username,ready:false});
    rooms[code]=room; socket.join(code); socket.roomCode=code;
    socket.emit('room_created',{code,playerIndex:0});
  });
  socket.on('join_room', ({code,username}) => {
    const room=rooms[code];
    if(!room) return socket.emit('error',{message:'Комната не найдена'});
    if(room.players.length>=2) return socket.emit('error',{message:'Комната полная'});
    if(room.started) return socket.emit('error',{message:'Игра уже началась'});
    room.players.push({id:socket.id,username,ready:false});
    socket.join(code); socket.roomCode=code;
    socket.emit('room_joined',{code,playerIndex:1,opponentName:room.players[0].username});
    io.to(room.players[0].id).emit('opponent_joined',{opponentName:username});
  });
  socket.on('player_ready', ()=>{
    const room=rooms[socket.roomCode]; if(!room) return;
    const p=room.players.find(p=>p.id===socket.id); if(p) p.ready=true;
    if(room.players.length===2&&room.players.every(p=>p.ready)){
      room.started=true;
      io.to(room.code).emit('game_start',{player0:room.players[0].username,player1:room.players[1].username});
    }
  });
  socket.on('move',({r,c})=>{ const room=rooms[socket.roomCode]; if(room) socket.to(room.code).emit('opponent_move',{r,c}); });
  socket.on('place_wall',({r,c,dir})=>{ const room=rooms[socket.roomCode]; if(room) socket.to(room.code).emit('opponent_wall',{r,c,dir}); });
  socket.on('surrender',()=>{ const room=rooms[socket.roomCode]; if(room) socket.to(room.code).emit('opponent_surrendered'); });
  socket.on('timeout',()=>{ const room=rooms[socket.roomCode]; if(room) socket.to(room.code).emit('opponent_timeout'); });
  socket.on('chat',({message})=>{
    const room=rooms[socket.roomCode]; if(!room) return;
    const player=room.players.find(p=>p.id===socket.id); if(!player) return;
    io.to(room.code).emit('chat_message',{username:player.username,message});
  });
  socket.on('rematch_request',()=>{ const room=rooms[socket.roomCode]; if(room) socket.to(room.code).emit('rematch_requested'); });
  socket.on('rematch_accept',()=>{
    const room=rooms[socket.roomCode]; if(!room) return;
    room.players.forEach(p=>p.ready=false); room.started=false;
    io.to(room.code).emit('rematch_start',{player0:room.players[0].username,player1:room.players[1].username});
  });
  socket.on('disconnect',()=>{
    const room=rooms[socket.roomCode]; if(!room) return;
    socket.to(room.code).emit('opponent_disconnected');
    delete rooms[socket.roomCode];
  });
});

app.get('/', (req,res) => res.send('Lomi Server OK'));
server.listen(PORT, () => console.log(`Lomi server on port ${PORT}`));
