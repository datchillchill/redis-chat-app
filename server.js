const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Redis = require('ioredis');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
  const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);

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

const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

redis.on('error', (err) => console.error('Redis lỗi:', err));
redis.on('connect', () => console.log('✅ Redis đã kết nối'));

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const USER_PRESENCE_TTL = 15; 
const MESSAGE_HISTORY_LIMIT = 100; 
const PRIVATE_CHAT_HISTORY_LIMIT = 50; 
const PRIVATE_CHAT_TTL = 7 * 24 * 60 * 60; 
const RATE_LIMIT_MESSAGES = 10; 
const MESSAGE_RETENTION_SECONDS = 60 * 60 * 24 * 7; 
const RATE_LIMIT_WINDOW = 60; 

  app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function generateToken(userId, username) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

async function createUserProfile(username, password, socketId) {
  try {
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    const USER_HASH_KEY = `user:${userId}`;
    const USERNAME_INDEX_KEY = `username:${username.toLowerCase()}`; 

    const userExists = await redis.get(USERNAME_INDEX_KEY);
    if (userExists) {
      return { error: 'Tên người dùng đã tồn tại' };
    }

    await redis.hset(USER_HASH_KEY, 
      'userId', userId,
      'username', username,
      'password', hashedPassword,
      'socketId', socketId, 
      'joinedAt', new Date().toISOString(),
      'avatar', `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
      'messageCount', 0,
      'status', 'offline' 
    );

    // Lưu username -> userId để tra cứu nhanh
    await redis.set(USERNAME_INDEX_KEY, userId); 
    
    const token = generateToken(userId, username);
    return { userId, token };
  } catch (error) {
    console.error('Lỗi tạo hồ sơ:', error);
    return { error: 'Lỗi tạo tài khoản' };
  }
}

async function authenticateUser(username, password) {
  try {
    const USERNAME_INDEX_KEY = `username:${username.toLowerCase()}`;
    const userId = await redis.get(USERNAME_INDEX_KEY);

    if (!userId) {
      return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    }

    const userProfile = await redis.hgetall(`user:${userId}`);
    if (!userProfile || !userProfile.password) {
        return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    }
    
    const passwordMatch = await bcrypt.compare(password, userProfile.password);

    if (!passwordMatch) {
      return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    }

    const token = generateToken(userId, userProfile.username); 
    return { userId, token, username: userProfile.username, success: true };
  } catch (error) {
    console.error('Lỗi xác thực:', error);
    return { error: 'Lỗi đăng nhập' };
  }
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  if (username.trim().length < 2 || username.trim().length > 30) return false;
  return /^[a-zA-Z0-9_-]+$/.test(username.trim());
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return false;
  if (password.length < 6) return false;
  return true;
}

function validateRoomName(roomName) {
  if (!roomName || typeof roomName !== 'string') return false;
  if (roomName.trim().length < 2 || roomName.trim().length > 50) return false;
  return true; 
}

function validateMessage(message) {
  if (!message || typeof message !== 'string') return false;
  if (message.trim().length === 0 || message.trim().length > 1000) return false;
  return true;
}

function sanitizeMessage(message) {
  return message
    .trim()
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

async function checkRateLimit(userId, type = 'message', targetId = 'global') {
  try {
    const RATE_KEY = `rate:${type}:${userId}:${targetId}`;
    const count = await redis.incr(RATE_KEY);
    
    if (count === 1) {
      await redis.expire(RATE_KEY, RATE_LIMIT_WINDOW);
    }

    return count <= RATE_LIMIT_MESSAGES;
  } catch (error) {
    console.error('Lỗi kiểm tra giới hạn:', error);
    return true; 
  }
}

async function recordUserActivity(userId, roomId = 'global') {
  try {
    const DATE_KEY = `activity:${new Date().toISOString().split('T')[0]}`; 
    const UNIQUE_USERS_KEY = `unique:${roomId}:${new Date().toISOString().split('T')[0]}`;
    
    await redis.sadd(DATE_KEY, userId); 
    await redis.sadd(UNIQUE_USERS_KEY, userId); 
  } catch (error) {
    console.error('Lỗi ghi lại hoạt động:', error);
  }
}

async function getStatistics() {
  try {
    const totalMessages = await redis.get('stats:totalMessages') || 0;
    const totalRegisteredUsers = (await redis.keys('username:*')).length;
    const activeRooms = await redis.smembers('app:rooms');
    
    return {
      totalMessages: parseInt(totalMessages),
      totalRegisteredUsers: totalRegisteredUsers,
      activeRoomsCount: activeRooms.length,
      activeRoomsList: activeRooms, 
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Lỗi lấy thống kê:', error);
    return null;
  }
}

const socketRoomMap = {}; 
const socketUserMap = {}; 
const userIdSocketMap = {}; 

const ALL_ROOMS_KEY = 'app:rooms';
const ALL_ONLINE_USERS_KEY = 'app:onlineUsers'; 
const defaultRooms = ['Phòng Chung', 'Công Nghệ', 'Học Tập'];

async function initializeRooms() {
  try {
    console.log("Khởi tạo danh sách phòng...");
    for (const room of defaultRooms) {
        await redis.sadd(ALL_ROOMS_KEY, room);
    }
    await redis.setnx('stats:totalMessages', 0); 
    console.log("✅ Danh sách phòng đã được cập nhật");
  } catch (err) {
    console.error("Lỗi khởi tạo phòng:", err);
  }
}

initializeRooms();

async function renewPresence(userId, roomId = 'global') {
  try {
    await redis.expire(ALL_ONLINE_USERS_KEY, USER_PRESENCE_TTL);

    if (roomId !== 'global') {
      const PRESENCE_KEY_ROOM = `presence:user:${roomId}:${userId}`;
      await redis.setex(PRESENCE_KEY_ROOM, USER_PRESENCE_TTL, '1');
    }
  } catch (error) {
    console.error('Lỗi làm mới trạng thái:', error);
  }
}

async function getUserOnlineStatus(userId) {
  const socketId = userIdSocketMap[userId];
  return socketId && io.sockets.adapter.sids.has(socketId);
}
async function broadcastOnlineUsers() {
  try {
    const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
    const onlineUsersDetails = [];
    for (const userId of onlineUserIds) {
      const userProfile = await redis.hgetall(`user:${userId}`);
      if (userProfile && userProfile.username) {
        onlineUsersDetails.push({
          userId: userProfile.userId,
          username: userProfile.username,
          avatar: userProfile.avatar,
        });
      }
    }
    io.emit('online users list', onlineUsersDetails);
  } catch (error) {
    console.error('Lỗi phát sóng danh sách online:', error);
  }
}
// Bắt đầu lắng nghe các kênh Redis
subClient.on('message', async (channel, message) => {
  try {
    const channelParts = channel.split(':');
    const type = channelParts[0]; 
    const targetId = channelParts[1];
    const updateType = channelParts[2]; 

    if (type === 'room' && updateType === 'updates') {
      const messageObject = JSON.parse(message);
      io.to(targetId).emit('chat message', messageObject);
    } else if (type === 'app' && targetId === 'rooms' && updateType === 'list_update') {
      const rooms = JSON.parse(message);
      io.emit('room list', rooms); 
    }
  } catch (e) {
    console.error("Lỗi phân tích tin nhắn từ Redis Pub/Sub:", e);
  }
});

io.on('connection', (socket) => {
  const socketId = socket.id;
  console.log(`✅ Người dùng mới kết nối: ${socketId}`);

  // Đăng ký người dùng mới
  socket.on('register', async ({ username, password }) => {
    try {
      if (!validateUsername(username)) {
        return socket.emit('error', 'Tên người dùng không hợp lệ (2-30 ký tự, chỉ chữ cái và số)');
      }

      if (!validatePassword(password)) {
        return socket.emit('error', 'Mật khẩu phải có ít nhất 6 ký tự');
      }

      const result = await createUserProfile(username, password, socketId);
      if (result.error) {
        return socket.emit('error', result.error);
      }

      socket.emit('auth_success', {
        userId: result.userId,
        token: result.token,
        username: username
      });
    } catch (error) {
      console.error('Lỗi đăng ký:', error);
      socket.emit('error', 'Lỗi đăng ký');
    }
  });

  // Đăng nhập người dùng
  socket.on('login', async ({ username, password }) => {
    try {
      console.log(`Đang thử đăng nhập: ${username}`);
      if (!validateUsername(username) || !validatePassword(password)) {
        return socket.emit('error', 'Tên đăng nhập hoặc mật khẩu không hợp lệ');
      }

      const result = await authenticateUser(username, password);
      if (result.error) {
        return socket.emit('error', result.error);
      }
      
      console.log(`Đăng nhập thành công: ${username}`);
      await redis.hset(`user:${result.userId}`, 'socketId', socketId, 'status', 'online');
      socket.data.userId = result.userId;
      socket.data.username = result.username;
      socketUserMap[socketId] = result.userId;
      socket.join(result.userId);

      await redis.sadd(ALL_ONLINE_USERS_KEY, result.userId);
      await renewPresence(result.userId); 
      await broadcastOnlineUsers(); 
      socket.emit('auth_success', {
        userId: result.userId,
        token: result.token,
      });
    } catch (error) {
      console.error('Lỗi đăng nhập:', error);
      socket.emit('error', 'Lỗi đăng nhập');
    }
  });

  app.get('/verify-token', (req, res) => {
    const token = req.cookies.chatToken;
  });

  // Xác thực token sau khi đăng nhập hoặc tải lại trang
  socket.on('authenticate', async ({ token }) => {
    try {
      const decoded = verifyToken(token);
      if (!decoded) {
        return socket.emit('error', 'Token không hợp lệ. Vui lòng đăng nhập lại.');
      }


      const userProfile = await redis.hgetall(`user:${decoded.userId}`);
      if (!userProfile) {
          return socket.emit('error', 'Người dùng không tồn tại.');
      }

      await redis.hset(`user:${decoded.userId}`, 'socketId', socketId, 'status', 'online');
      socket.data.userId = decoded.userId;
      socket.data.username = userProfile.username; 
      socketUserMap[socketId] = decoded.userId;
      socket.join(decoded.userId);

      socket.on('get_token', () => {
        socket.emit('token', localStorage.getItem('chatToken'));
      });

     await redis.sadd(ALL_ONLINE_USERS_KEY, decoded.userId);
      await renewPresence(decoded.userId); 

      const rooms = await redis.smembers(ALL_ROOMS_KEY);
      socket.emit('room list', rooms);

      subClient.subscribe(`app:rooms:list_update`);
      subClient.subscribe(`app:onlineUsers:update`);

      await broadcastOnlineUsers(); 
    const unreadCounts = await redis.hgetall(`unread_counts:${decoded.userId}`);
    socket.emit('all_unread_counts', unreadCounts);

      socket.emit('auth_verified', { username: userProfile.username, userId: decoded.userId });
    } catch (error) {
      console.error('Lỗi xác thực token:', error);
      socket.emit('error', 'Lỗi xác thực');
    }
  });

  // Tạo phòng chat mới
  socket.on('create room', async ({ roomName }) => {
    console.log("Received create room request with name:", roomName)
    try {
      if (!socket.data.userId) {
        return socket.emit('error', 'Bạn cần đăng nhập để tạo phòng.');
      }
      if (!validateRoomName(roomName)) {
        return socket.emit('error', 'Tên phòng không hợp lệ (2-50 ký tự).');
      }

      const roomExists = await redis.sismember(ALL_ROOMS_KEY, roomName);
      if (roomExists) {
        return socket.emit('error', 'Phòng này đã tồn tại.');
      }

      await redis.sadd(ALL_ROOMS_KEY, roomName);
      const updatedRooms = await redis.smembers(ALL_ROOMS_KEY);

      pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));
      
      socket.emit('room created', roomName); 
      console.log(`Phòng mới được tạo: ${roomName} bởi ${socket.data.username}`);

    } catch (error) {
      console.error('Lỗi tạo phòng:', error);
      socket.emit('error', 'Lỗi tạo phòng');
    }
    console.log("Finished create room request");
  });

  // Tham gia phòng chat
  socket.on('join room', async ({ roomId }) => {
      try {
          const { userId, username } = socket.data;
          if (!userId) {
              return socket.emit('error', 'Bạn chưa xác thực để tham gia phòng.');
          }

          const currentRoomId = socketRoomMap[socket.id]; 
          
          // Rời khỏi phòng hiện tại nếu có
          if (currentRoomId && currentRoomId !== roomId) { 
              socket.leave(currentRoomId);
              subClient.unsubscribe(`room:${currentRoomId}:updates`);
              
              await redis.srem(`online:room:${currentRoomId}`, userId);

              pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({
                  user: 'Hệ thống',
                  text: `${username} đã rời phòng.`,
                  timestamp: Date.now(),
                  isSystem: true
              }));
          }

          socket.join(roomId);
          await redis.hdel(`unread_counts:${userId}`, roomId);
          socket.emit('unread_update', { chatId: roomId, count: 0 });
          socketRoomMap[socket.id] = roomId;
          subClient.subscribe(`room:${roomId}:updates`);

          await redis.sadd(`online:room:${roomId}`, userId);
          await redis.expire(`online:room:${roomId}`, 86400);

          await renewPresence(userId, roomId);
          await recordUserActivity(userId, roomId);

          const onlineUserIdsInRoom = await redis.smembers(`online:room:${roomId}`);
          const onlineUsernamesInRoom = [];
          for (const uid of onlineUserIdsInRoom) {
              const uname = await redis.hget(`user:${uid}`, 'username');
              if (uname) onlineUsernamesInRoom.push(uname);
          }
          io.to(roomId).emit('room online users', onlineUsernamesInRoom);

          const MESSAGES_HASH_KEY = `messages:${roomId}`;
          const ORDER_ZSET_KEY = `order:${roomId}`;
          const messageIds = await redis.zrange(ORDER_ZSET_KEY, -MESSAGE_HISTORY_LIMIT, -1);

          if (messageIds.length > 0) {
              const historyMessages = await redis.hmget(MESSAGES_HASH_KEY, ...messageIds);
              const formattedHistory = historyMessages
                  .filter(msg => msg)
                  .map(msg => JSON.parse(msg));
              socket.emit('history', formattedHistory);
          } else {
              socket.emit('history', []);
          }

          const pinnedMessageId = await redis.get(`pinned_message:${roomId}`);
          if (pinnedMessageId) {
              const pinnedMessageString = await redis.hget(`messages:${roomId}`, pinnedMessageId);
              if (pinnedMessageString) {
                  socket.emit('message_pinned', { 
                      chatId: roomId, 
                      pinnedMessage: JSON.parse(pinnedMessageString) 
                  });
              }
          } else {
              socket.emit('message_pinned', { chatId: roomId, pinnedMessage: null });
          }

          pubClient.publish(`room:${roomId}:updates`, JSON.stringify({
              user: 'Hệ thống',
              text: `${username} đã tham gia phòng.`,
              timestamp: Date.now(),
              isSystem: true
          }));

      } catch (error) {
          console.error('Lỗi tham gia phòng:', error);
          socket.emit('error', 'Lỗi tham gia phòng');
      }
  }); 

  // Gửi tin nhắn trong phòng chat
  socket.on('chat message', async (msg) => {
      try {
          const roomId = socketRoomMap[socketId];
          const { username, userId } = socket.data;

          if (!roomId || !username) {
              return socket.emit('error', 'Bạn chưa tham gia phòng nào để gửi tin nhắn.');
          }

          if (!validateMessage(msg.text)) {
              return socket.emit('error', 'Tin nhắn không hợp lệ (tối đa 1000 ký tự và không rỗng).');
          }

          const allowed = await checkRateLimit(userId, 'room_message', roomId);
          if (!allowed) {
              return socket.emit('error', 'Bạn gửi tin quá nhanh. Hãy chờ một chút!');
          }

          const sanitizedText = sanitizeMessage(msg.text);
          await renewPresence(userId, roomId);

          const MESSAGES_HASH_KEY = `messages:${roomId}`;
          const ORDER_ZSET_KEY = `order:${roomId}`;
          const CHANNEL_NAME = `room:${roomId}:updates`;

          let replyToObject = null;
          if (msg.replyTo && msg.replyTo.messageId) {
              const originalMessageString = await redis.hget(MESSAGES_HASH_KEY, msg.replyTo.messageId);
              if (originalMessageString) {
                  const originalMessage = JSON.parse(originalMessageString);
                  const originalUser = originalMessage.user || originalMessage.senderUsername;
                  const originalText = originalMessage.text;

                  if (originalUser && originalText) {
                      replyToObject = {
                          messageId: originalMessage.messageId,
                          user: originalUser,
                          text: originalText.substring(0, 75) + (originalText.length > 75 ? '...' : '')
                      };
                  }
              }
          }

          const messageId = uuidv4();
          const timestamp = Date.now();

          const messageObject = {
              messageId: messageId,
              roomId: roomId,
              user: username,
              text: sanitizedText,
              timestamp: timestamp,
              userId: userId,
              avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
              reactions: {},
              replyTo: replyToObject
          };

          const messageString = JSON.stringify(messageObject);

          const pipeline = redis.pipeline();
          pipeline.hset(MESSAGES_HASH_KEY, messageId, messageString);
          pipeline.zadd(ORDER_ZSET_KEY, timestamp, messageId);
          pipeline.expire(MESSAGES_HASH_KEY, MESSAGE_RETENTION_SECONDS);
          pipeline.expire(ORDER_ZSET_KEY, 604800);

          if (msg.replyTo && msg.replyTo.messageId) {
              const REPLIES_TO_KEY = `replies_to:${msg.replyTo.messageId}`;
              pipeline.sadd(REPLIES_TO_KEY, messageId);
              pipeline.expire(REPLIES_TO_KEY, MESSAGE_RETENTION_SECONDS);
          }
          
          await pipeline.exec();

          await redis.incr('stats:totalMessages');
          await redis.hincrby(`user:${userId}`, 'messageCount', 1);

          pubClient.publish(CHANNEL_NAME, messageString);
          const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
          for (const onlineUserId of onlineUserIds) {
              if (onlineUserId !== userId) {
                  const newCount = await redis.hincrby(`unread_counts:${onlineUserId}`, roomId, 1);
                  io.to(onlineUserId).emit('unread_update', { chatId: roomId, count: newCount });
              }
          }

      } catch (error) {
          console.error('Lỗi gửi tin nhắn phòng:', error);
          socket.emit('error', 'Lỗi gửi tin nhắn phòng');
      }
  });

  // Xử lý sửa tin nhắn
  socket.on('edit message', async ({ messageId, newText, chatId }) => { 
      try {
          const userId = socket.data.userId;
          if (!chatId || !userId) return; 

          if (!validateMessage(newText)) {
              return socket.emit('error', 'Nội dung tin nhắn không hợp lệ.');
          }

          const MESSAGES_HASH_KEY = `messages:${chatId}`; 
          const messageString = await redis.hget(MESSAGES_HASH_KEY, messageId);
          if (!messageString) return;

          const messageObject = JSON.parse(messageString);

          if (messageObject.userId !== userId && messageObject.senderId !== userId) {
              return socket.emit('error', 'Bạn không có quyền sửa tin nhắn này.');
          }
          
          messageObject.text = sanitizeMessage(newText);
          messageObject.edited = true;

          await redis.hset(MESSAGES_HASH_KEY, messageId, JSON.stringify(messageObject));

          if (chatId.startsWith('private:')) {
              const participants = chatId.split(':');
              io.to(participants[1]).to(participants[2]).emit('message edited', messageObject);
          } else {
              io.to(chatId).emit('message edited', messageObject);
          }

      } catch (error) {
          console.error('Lỗi sửa tin nhắn:', error);
          socket.emit('error', 'Lỗi khi sửa tin nhắn.');
      }
  });

  // Xử lý xóa tin nhắn
  socket.on('delete message', async ({ messageId, chatId }) => {
      try {
          const userId = socket.data.userId;
          if (!chatId || !userId) return;

          const MESSAGES_HASH_KEY = `messages:${chatId}`;
          const ORDER_ZSET_KEY = `order:${chatId}`;

          const messageString = await redis.hget(MESSAGES_HASH_KEY, messageId);
          if (!messageString) return;

          const messageObject = JSON.parse(messageString);
          if (messageObject.userId !== userId && messageObject.senderId !== userId) {
              return socket.emit('error', 'Bạn không có quyền xóa tin nhắn này.');
          }

          const PINNED_KEY = `pinned_message:${chatId}`;
          const currentlyPinnedId = await redis.get(PINNED_KEY);

          if (currentlyPinnedId === messageId) {
              await redis.del(PINNED_KEY);

              const payload = { chatId, pinnedMessage: null };
              if (chatId.startsWith('private:')) {
                  const participants = chatId.split(':');
                  io.to(participants[1]).to(participants[2]).emit('message_pinned', payload);
              } else {
                  io.to(chatId).emit('message_pinned', payload);
              }
          }

          const REPLIES_TO_KEY = `replies_to:${messageId}`;
          const replyingMessageIds = await redis.smembers(REPLIES_TO_KEY);

          for (const replyingId of replyingMessageIds) {
              const replyingMessageString = await redis.hget(MESSAGES_HASH_KEY, replyingId);
              if (replyingMessageString) {
                  const replyingMessageObject = JSON.parse(replyingMessageString);
                  if (replyingMessageObject.replyTo) {
                      replyingMessageObject.replyTo.text = "Tin nhắn đã bị xóa";
                      replyingMessageObject.replyTo.isDeleted = true;
                  }
                  await redis.hset(MESSAGES_HASH_KEY, replyingId, JSON.stringify(replyingMessageObject));
                  if (chatId.startsWith('private:')) {
                      const participants = chatId.split(':');
                      io.to(participants[1]).to(participants[2]).emit('message edited', replyingMessageObject);
                  } else {
                      io.to(chatId).emit('message edited', replyingMessageObject);
                  }
              }
          }

          const pipeline = redis.pipeline();
          pipeline.hdel(MESSAGES_HASH_KEY, messageId);
          pipeline.zrem(ORDER_ZSET_KEY, messageId);
          pipeline.del(REPLIES_TO_KEY);
          await pipeline.exec();

          if (chatId.startsWith('private:')) {
              const participants = chatId.split(':');
              io.to(participants[1]).to(participants[2]).emit('message deleted', { messageId });
          } else {
              io.to(chatId).emit('message deleted', { messageId });
          }

      } catch (error) {
          console.error('Lỗi xóa tin nhắn:', error);
          socket.emit('error', 'Lỗi khi xóa tin nhắn.');
      }
  });

  // Xử lý thả icon vào tin nhắn 
  socket.on('react to message', async ({ messageId, emoji, chatId }) => { 
      try {
          const { userId, username } = socket.data;
          if (!chatId || !userId) return; 

          const MESSAGES_HASH_KEY = `messages:${chatId}`; 
          const messageString = await redis.hget(MESSAGES_HASH_KEY, messageId);
          if (!messageString) return;

          const messageObject = JSON.parse(messageString);
          if (!messageObject.reactions) {
              messageObject.reactions = {};
          }
          const isTogglingOff = messageObject.reactions[emoji]?.some(r => r.userId === userId);
          for (const anEmoji in messageObject.reactions) {
              const userIndex = messageObject.reactions[anEmoji].findIndex(r => r.userId === userId);
              if (userIndex > -1) {
                  messageObject.reactions[anEmoji].splice(userIndex, 1);
                  if (messageObject.reactions[anEmoji].length === 0) {
                      delete messageObject.reactions[anEmoji];
                  }
              }
          }
          if (!isTogglingOff) {
              if (!messageObject.reactions[emoji]) {
                  messageObject.reactions[emoji] = [];
              }
              messageObject.reactions[emoji].push({ userId, username });
          }
          
          await redis.hset(MESSAGES_HASH_KEY, messageId, JSON.stringify(messageObject));
          

          if (chatId.startsWith('private:')) {
              const participants = chatId.split(':');
              io.to(participants[1]).to(participants[2]).emit('message reacted', messageObject);
          } else {
              io.to(chatId).emit('message reacted', messageObject);
          }

      } catch (error) {
          console.error('Lỗi thả icon:', error);
          socket.emit('error', 'Lỗi khi thả icon.');
      }
  });

  // Xử lý khi client báo đã đọc tin nhắn trong một cuộc trò chuyện
  socket.on('mark_as_read', async ({ chatId }) => {
      try {
          const userId = socket.data.userId;
          if (!userId || !chatId) return;

          await redis.hdel(`unread_counts:${userId}`, chatId);
          
          socket.emit('unread_update', { chatId: chatId, count: 0 });

      } catch (error) {
          console.error('Lỗi đánh dấu đã đọc:', error);
      }
  });

  // Xử lý ghim/bỏ ghim tin nhắn
  socket.on('pin_message', async ({ messageId, chatId }) => {
      try {
          const { userId } = socket.data;
          if (!chatId || !userId) return;

          const PINNED_KEY = `pinned_message:${chatId}`;
          const currentPinnedId = await redis.get(PINNED_KEY);

          let newPinnedMessage = null;

          if (currentPinnedId === messageId) {
              await redis.del(PINNED_KEY);
          } else {
              const messageString = await redis.hget(`messages:${chatId}`, messageId);
              if (messageString) {
                  await redis.set(PINNED_KEY, messageId);
                  newPinnedMessage = JSON.parse(messageString);
              }
          }
          
          // Phát sóng cập nhật đến mọi người trong cuộc trò chuyện
          const payload = { chatId, pinnedMessage: newPinnedMessage };
          if (chatId.startsWith('private:')) {
              const participants = chatId.split(':');
              io.to(participants[1]).to(participants[2]).emit('message_pinned', payload);
          } else {
              io.to(chatId).emit('message_pinned', payload);
          }

      } catch (error) {
          console.error('Lỗi ghim tin nhắn:', error);
      }
  });

  // Xử lý khi người dùng bắt đầu gõ
  socket.on('start_typing', ({ chatId }) => {
      try {
          const { userId, username } = socket.data;
          if (!chatId || !username) return;

          if (chatId.startsWith('private:')) {
              const participants = chatId.split(':');
              const otherUserId = participants[1] === userId ? participants[2] : participants[1];
              io.to(otherUserId).emit('user_typing', { username, chatId });
          } else {
              socket.to(chatId).emit('user_typing', { username, chatId });
          }
      } catch (error) {
          console.error("Lỗi sự kiện 'start_typing':", error);
      }
  });

  // Xử lý khi người dùng ngừng gõ
  socket.on('stop_typing', ({ chatId }) => {
      try {
          const { userId, username } = socket.data;
          if (!chatId || !username) return;

          if (chatId.startsWith('private:')) {
              const participants = chatId.split(':');
              const otherUserId = participants[1] === userId ? participants[2] : participants[1];
              io.to(otherUserId).emit('user_stopped_typing', { username, chatId });
          } else {
              socket.to(chatId).emit('user_stopped_typing', { username, chatId });
          }
      } catch (error) {
          console.error("Lỗi sự kiện 'stop_typing':", error);
      }
  });

  // Gửi tin nhắn riêng tư
  socket.on('send private message', async ({ receiverUserId, text, replyTo }) => {
      try {
          const senderUserId = socket.data.userId;
          const senderUsername = socket.data.username;

          if (!senderUserId || !senderUsername) {
              return socket.emit('error', 'Bạn cần đăng nhập để gửi tin nhắn riêng tư.');
          }
          if (senderUserId === receiverUserId) {
              return socket.emit('error', 'Bạn không thể tự nhắn tin cho chính mình.');
          }
          if (!validateMessage(text)) {
              return socket.emit('error', 'Tin nhắn không hợp lệ.');
          }

          const allowed = await checkRateLimit(senderUserId, 'private_message', receiverUserId);
          if (!allowed) {
              return socket.emit('error', 'Bạn gửi tin riêng quá nhanh. Hãy chờ một chút!');
          }

          const sanitizedText = sanitizeMessage(text);
          const receiverUsername = await redis.hget(`user:${receiverUserId}`, 'username');
          if (!receiverUsername) {
              return socket.emit('error', 'Người nhận không tồn tại.');
          }

          const chatParticipants = [senderUserId, receiverUserId].sort();
          const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;

          const MESSAGES_HASH_KEY = `messages:${privateChatId}`;
          const ORDER_ZSET_KEY = `order:${privateChatId}`;
          
          let replyToObject = null;
          if (replyTo && replyTo.messageId) {
              const originalMessageString = await redis.hget(MESSAGES_HASH_KEY, replyTo.messageId);
              if (originalMessageString) {
                  const originalMessage = JSON.parse(originalMessageString);
                  const originalUser = originalMessage.user || originalMessage.senderUsername;
                  const originalText = originalMessage.text;

                  if (originalUser && originalText) {
                      replyToObject = {
                          messageId: originalMessage.messageId,
                          user: originalUser,
                          text: originalText.substring(0, 75) + (originalText.length > 75 ? '...' : '')
                      };
                  }
              }
          }

          const messageId = uuidv4();
          const timestamp = Date.now();

          const messageObject = {
              messageId: messageId,
              senderId: senderUserId,
              senderUsername: senderUsername,
              receiverId: receiverUserId,
              receiverUsername: receiverUsername,
              text: sanitizedText,
              timestamp: timestamp,
              avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${senderUsername}`,
              reactions: {},
              replyTo: replyToObject
          };

          const messageString = JSON.stringify(messageObject);

          const pipeline = redis.pipeline();
          pipeline.hset(MESSAGES_HASH_KEY, messageId, messageString);
          pipeline.zadd(ORDER_ZSET_KEY, timestamp, messageId);
          pipeline.expire(MESSAGES_HASH_KEY, PRIVATE_CHAT_TTL);
          pipeline.expire(ORDER_ZSET_KEY, PRIVATE_CHAT_TTL);

          // === DÒNG CODE BỊ THIẾU TRƯỚC ĐÂY ĐÃ ĐƯỢC THÊM VÀO ĐÂY ===
          // Nếu đây là một tin nhắn trả lời, lưu lại mối quan hệ
          if (replyTo && replyTo.messageId) {
              const REPLIES_TO_KEY = `replies_to:${replyTo.messageId}`;
              pipeline.sadd(REPLIES_TO_KEY, messageId);
              pipeline.expire(REPLIES_TO_KEY, PRIVATE_CHAT_TTL);
          }
          // === KẾT THÚC PHẦN BỔ SUNG ===
          
          await pipeline.exec();
          
          await redis.incr('stats:totalMessages');
          await redis.hincrby(`user:${senderUserId}`, 'messageCount', 1);

          socket.emit('private message', messageObject);
          io.to(receiverUserId).emit('private message', messageObject);
          const newCount = await redis.hincrby(`unread_counts:${receiverUserId}`, privateChatId, 1);
          io.to(receiverUserId).emit('unread_update', { chatId: privateChatId, count: newCount });

          await renewPresence(senderUserId);
      } catch (error) {
          console.error('Lỗi gửi tin nhắn riêng tư:', error);
          socket.emit('error', 'Lỗi gửi tin nhắn riêng tư');
      }
  });

  // Lấy lịch sử chat riêng tư 
  socket.on('get private history', async ({ targetUserId }) => {
      try {
          const senderUserId = socket.data.userId;
          const chatParticipantsForReset = [senderUserId, targetUserId].sort();
          const privateChatIdForReset = `private:${chatParticipantsForReset[0]}:${chatParticipantsForReset[1]}`;
          await redis.hdel(`unread_counts:${senderUserId}`, privateChatIdForReset);
          socket.emit('unread_update', { chatId: privateChatIdForReset, count: 0 });
          if (!senderUserId) {
              return socket.emit('error', 'Bạn cần đăng nhập để xem lịch sử chat riêng.');
          }

          const chatParticipants = [senderUserId, targetUserId].sort();
          const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;

          const MESSAGES_HASH_KEY = `messages:${privateChatId}`;
          const ORDER_ZSET_KEY = `order:${privateChatId}`;

          const messageIds = await redis.zrange(ORDER_ZSET_KEY, -PRIVATE_CHAT_HISTORY_LIMIT, -1);

          if (messageIds.length > 0) {
              const historyMessages = await redis.hmget(MESSAGES_HASH_KEY, ...messageIds);
              const formattedHistory = historyMessages
                  .filter(msg => msg)
                  .map(msg => JSON.parse(msg));
              socket.emit('private chat history', { targetUserId, history: formattedHistory });
          } else {
              socket.emit('private chat history', { targetUserId, history: [] });
          }
      } catch (error) {
          console.error('Lỗi lấy lịch sử chat riêng:', error);
          socket.emit('error', 'Lỗi lấy lịch sử chat riêng tư');
      }
  });

  // Lấy danh sách người dùng online (toàn cầu)
  socket.on('get online users list', async () => {
    try {
      const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
      const onlineUsersDetails = [];
      for (const userId of onlineUserIds) {
          const userProfile = await redis.hgetall(`user:${userId}`);
          if (userProfile && getUserOnlineStatus(userId)) { 
            onlineUsersDetails.push({
                userId: userProfile.userId,
                username: userProfile.username,
                avatar: userProfile.avatar,
                status: 'online'
            });
          }
      }
      socket.emit('online users list', onlineUsersDetails);
    } catch (error) {
      console.error('Lỗi lấy danh sách người dùng online:', error);
      socket.emit('error', 'Lỗi lấy danh sách người dùng online');
    }
  });

  // Lấy thống kê ứng dụng
  socket.on('get stats', async () => {
    try {
      const stats = await getStatistics();
      socket.emit('stats', stats);
    } catch (error) {
      console.error('Lỗi lấy thống kê:', error);
    }
  });

  // Xử lý khi người dùng ngắt kết nối
  socket.on('disconnect', async () => {
      try {
          const userId = socket.data.userId;
          const username = socket.data.username;
          console.log(`❌ Người dùng ngắt kết nối: ${socket.id} (User: ${username || 'N/A'})`);

          setTimeout(async () => {
              const userSockets = io.sockets.adapter.rooms.get(userId);

              if (!userSockets || userSockets.size === 0) {
                  console.log(`User ${username} is now fully offline.`);
                  if (userId) {
                      await redis.srem(ALL_ONLINE_USERS_KEY, userId);
                      await redis.hset(`user:${userId}`, 'status', 'offline');

                      await broadcastOnlineUsers();
                  }
              } else {
                  console.log(`User ${username} is still online with other connections.`);
              }
          }, 500); 

          const currentRoomId = socketRoomMap[socketId];
          if (currentRoomId && username && userId) {
              subClient.unsubscribe(`room:${currentRoomId}:updates`);
              await redis.srem(`online:room:${currentRoomId}`, userId);
              
              pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({
                  user: 'Hệ thống',
                  text: `${username} đã rời khỏi phòng.`,
                  timestamp: Date.now(),
                  isSystem: true
              }));

              const onlineUserIdsInRoom = await redis.smembers(`online:room:${currentRoomId}`);
              const onlineUsernamesInRoom = [];
              for (const uid of onlineUserIdsInRoom) {
                  const uname = await redis.hget(`user:${uid}`, 'username');
                  if (uname) onlineUsernamesInRoom.push(uname);
              }
              io.to(currentRoomId).emit('room online users', onlineUsernamesInRoom);
          }

          delete socketRoomMap[socket.id];
          delete socketUserMap[socket.id];

      } catch (error) {
          console.error('Lỗi ngắt kết nối:', error);
      }
  });

  // Cung cấp toàn bộ lịch sử chat cho chức năng tìm kiếm
  socket.on('get full history', async ({ chatId }, callback) => {
      try {
          if (!chatId) return;

          const MESSAGES_HASH_KEY = `messages:${chatId}`;
          const ORDER_ZSET_KEY = `order:${chatId}`;

          const allMessageIds = await redis.zrange(ORDER_ZSET_KEY, 0, -1);

          if (allMessageIds.length > 0) {
              const allMessages = await redis.hmget(MESSAGES_HASH_KEY, ...allMessageIds);
              const formattedHistory = allMessages
                  .filter(msg => msg)
                  .map(msg => JSON.parse(msg));
              callback(formattedHistory);
          } else {
              callback([]);
          }
      } catch (error) {
          console.error('Lỗi lấy toàn bộ lịch sử:', error);
          callback([]); 
      }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
  console.log(`📊 Ứng dụng Chat Redis đã khởi động`);
});