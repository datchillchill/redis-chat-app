// server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Redis = require('ioredis');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const multer = require('multer');

// === KHỞI TẠO CÁC THÀNH PHẦN CHÍNH ===
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    enableReadyCheck: false,
    enableOfflineQueue: false
});
const pubClient = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});
const subClient = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redis.on('error', (err) => console.error('Redis lỗi:', err));
redis.on('connect', () => console.log('✅ Redis đã kết nối'));

// Bắt đầu lắng nghe các kênh Redis để phát sóng sự kiện
subClient.on('message', async (channel, message) => {
  try {
    const channelParts = channel.split(':');
    const type = channelParts[0]; 
    const targetId = channelParts[1];
    const updateType = channelParts[2]; 

    // Nếu có tin nhắn mới trong một phòng, phát nó đến những người trong phòng đó
    if (type === 'room' && updateType === 'updates') {
      const messageObject = JSON.parse(message);
      io.to(targetId).emit('chat message', messageObject);
    } 
    // Nếu danh sách phòng chung thay đổi, báo cho tất cả người dùng
    else if (type === 'app' && targetId === 'rooms' && updateType === 'list_update') {
      const rooms = JSON.parse(message);
      io.emit('room list', rooms); 
    }
  } catch (e) {
    console.error("Lỗi phân tích tin nhắn từ Redis Pub/Sub:", e);
  }
});

// === CÁC BIẾN VÀ HÀM TRỢ GIÚP CHUNG ===
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const ADMIN_TOKEN_SECRET = JWT_SECRET + '-admin';
const ALL_ROOMS_KEY = 'app:rooms';
const ALL_ONLINE_USERS_KEY = 'app:onlineUsers';
const defaultRooms = [];
const USER_PRESENCE_TTL = 15;
const MESSAGE_HISTORY_LIMIT = 100;
const PRIVATE_CHAT_HISTORY_LIMIT = 50;
const PRIVATE_CHAT_TTL = 7 * 24 * 60 * 60;
const RATE_LIMIT_MESSAGES = 10;
const MESSAGE_RETENTION_SECONDS = 60 * 60 * 24 * 7;
const RATE_LIMIT_WINDOW = 60;
const socketRoomMap = {};
const socketUserMap = {};
const userIdSocketMap = {};

function generateToken(userId, username) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '24h' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; }
}
function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  if (username.trim().length < 2 || username.trim().length > 30) return false;
  return /^[a-zA-Z0-9_-]+$/.test(username.trim());
}
function validatePassword(password) {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 6;
}
function validateRoomName(roomName) {
  if (!roomName || typeof roomName !== 'string') return false;
  return roomName.trim().length >= 2 && roomName.trim().length <= 50;
}
function validateMessage(message) {
  if (!message || typeof message !== 'string') return false;
  return message.trim().length > 0 && message.trim().length <= 1000;
}
function sanitizeMessage(message) {
  return message.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function getMessageContentPreview(msg) {
    if (msg.text) return msg.text;
    if (msg.file && msg.file.name) {
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
        const extension = msg.file.name.split('.').pop().toLowerCase();
        return imageExtensions.includes(extension) ? '[Hình ảnh]' : `[Tệp tin] ${msg.file.name}`;
    }
    return '';
}
async function createUserProfile(username, password, socketId) {
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    const USER_HASH_KEY = `user:${userId}`;
    const USERNAME_INDEX_KEY = `username:${username.toLowerCase()}`;
    if (await redis.get(USERNAME_INDEX_KEY)) return { error: 'Tên người dùng đã tồn tại' };
    await redis.hset(USER_HASH_KEY, 'userId', userId, 'username', username, 'password', hashedPassword, 'socketId', socketId, 'joinedAt', new Date().toISOString(), 'avatar', `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`, 'messageCount', 0, 'status', 'offline');
    await redis.set(USERNAME_INDEX_KEY, userId);
    const token = generateToken(userId, username);
    return { userId, token };
}
async function authenticateUser(username, password) {
    const USERNAME_INDEX_KEY = `username:${username.toLowerCase()}`;
    const userId = await redis.get(USERNAME_INDEX_KEY);
    if (!userId) return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    const userProfile = await redis.hgetall(`user:${userId}`);
    if (!userProfile || !userProfile.password) return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    const passwordMatch = await bcrypt.compare(password, userProfile.password);
    if (!passwordMatch) return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    const token = generateToken(userId, userProfile.username);
    return { userId, token, username: userProfile.username, success: true };
}
async function checkRateLimit(userId, type = 'message', targetId = 'global') {
    const RATE_KEY = `rate:${type}:${userId}:${targetId}`;
    const count = await redis.incr(RATE_KEY);
    if (count === 1) await redis.expire(RATE_KEY, RATE_LIMIT_WINDOW);
    return count <= RATE_LIMIT_MESSAGES;
}
async function recordUserActivity(userId, roomId = 'global') {
    const DATE_KEY = `activity:${new Date().toISOString().split('T')[0]}`;
    await redis.sadd(DATE_KEY, userId);
    await redis.sadd(`unique:${roomId}:${new Date().toISOString().split('T')[0]}`, userId);
}
async function renewPresence(userId, roomId = 'global') {
    await redis.expire(ALL_ONLINE_USERS_KEY, USER_PRESENCE_TTL);
    if (roomId !== 'global') {
        await redis.setex(`presence:user:${roomId}:${userId}`, USER_PRESENCE_TTL, '1');
    }
}
async function broadcastOnlineUsers() {
    const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
    const onlineUsersDetails = [];
    for (const userId of onlineUserIds) {
        const userProfile = await redis.hgetall(`user:${userId}`);
        if (userProfile && userProfile.username) {
            onlineUsersDetails.push({ userId: userProfile.userId, username: userProfile.username, avatar: userProfile.avatar });
        }
    }
    io.emit('online users list', onlineUsersDetails);
}
async function initializeRooms() {
  try {
    for (const room of defaultRooms) await redis.sadd(ALL_ROOMS_KEY, room);
    await redis.setnx('stats:totalMessages', 0);
    console.log("✅ Danh sách phòng đã được cập nhật");
  } catch (err) { console.error("Lỗi khởi tạo phòng:", err); }
}

// === MIDDLEWARE ===
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// === ROUTES ===
const adminRoutes = require('./routes/admin');
adminRoutes(app, redis, JWT_SECRET, defaultRooms, ALL_ROOMS_KEY, io, pubClient);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === SOCKET.IO MIDDLEWARE & INITIALIZATION ===
io.use((socket, next) => {
    const parser = cookieParser();
    parser(socket.request, {}, () => {
        const token = socket.request.cookies.admin_token;
        if (token) {
            try {
                jwt.verify(token, ADMIN_TOKEN_SECRET);
                socket.isAdmin = true; 
            } catch (err) {
            }
        }
        next(); 
    });
});

const initializeChat = require('./socket/chat');
initializeChat(io, redis, pubClient, subClient, {
    validateUsername, validatePassword, createUserProfile, authenticateUser,
    verifyToken, ALL_ONLINE_USERS_KEY, renewPresence, broadcastOnlineUsers,
    ALL_ROOMS_KEY, validateRoomName, socketRoomMap, socketUserMap, userIdSocketMap,
    getMessageContentPreview, validateMessage, checkRateLimit, sanitizeMessage,
    MESSAGE_RETENTION_SECONDS, PRIVATE_CHAT_TTL, defaultRooms,
    MESSAGE_HISTORY_LIMIT, PRIVATE_CHAT_HISTORY_LIMIT, JWT_SECRET,
    io,
    uuidv4, bcrypt
});

// === KHỞI ĐỘNG SERVER ===
initializeRooms();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});