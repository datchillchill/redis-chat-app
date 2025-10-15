const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Redis = require('ioredis');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

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
const USER_PRESENCE_TTL = 15; // Thời gian tồn tại của trạng thái online (giây)
const MESSAGE_HISTORY_LIMIT = 100; // Giới hạn số lượng tin nhắn lịch sử mỗi phòng
const PRIVATE_CHAT_HISTORY_LIMIT = 50; // Giới hạn số lượng tin nhắn lịch sử chat riêng
const PRIVATE_CHAT_TTL = 7 * 24 * 60 * 60; // Lịch sử chat riêng tồn tại 7 ngày (giây) nếu không có hoạt động
const RATE_LIMIT_MESSAGES = 10; // Số lượng tin nhắn tối đa trong cửa sổ thời gian
const RATE_LIMIT_WINDOW = 60; // Cửa sổ thời gian cho giới hạn tốc độ (giây)

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
    const USERNAME_INDEX_KEY = `username:${username.toLowerCase()}`; // Lưu tên người dùng dưới dạng chữ thường để tra cứu không phân biệt chữ hoa/thường

    const userExists = await redis.get(USERNAME_INDEX_KEY);
    if (userExists) {
      return { error: 'Tên người dùng đã tồn tại' };
    }

    await redis.hset(USER_HASH_KEY, 
      'userId', userId,
      'username', username,
      'password', hashedPassword,
      'socketId', socketId, // Có thể cập nhật sau khi đăng nhập
      'joinedAt', new Date().toISOString(),
      'avatar', `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
      'messageCount', 0,
      'status', 'offline' // Mặc định là offline khi tạo
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

    const token = generateToken(userId, userProfile.username); // Sử dụng username từ profile
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
  return true; // Cho phép ký tự đặc biệt, nhưng có thể cân nhắc thêm regex nếu cần
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
    return true; // Nếu có lỗi Redis, cho phép gửi để không làm gián đoạn trải nghiệm người dùng
  }
}

async function recordUserActivity(userId, roomId = 'global') {
  try {
    const DATE_KEY = `activity:${new Date().toISOString().split('T')[0]}`; // Định dạng YYYY-MM-DD
    const UNIQUE_USERS_KEY = `unique:${roomId}:${new Date().toISOString().split('T')[0]}`;
    
    await redis.sadd(DATE_KEY, userId); // Tổng số người dùng hoạt động trong ngày
    await redis.sadd(UNIQUE_USERS_KEY, userId); // Người dùng duy nhất trong phòng này hôm nay
  } catch (error) {
    console.error('Lỗi ghi lại hoạt động:', error);
  }
}

async function getStatistics() {
  try {
    const totalMessages = await redis.get('stats:totalMessages') || 0;
    const totalRegisteredUsers = (await redis.keys('username:*')).length; // Số lượng user profile dựa vào username index
    const activeRooms = await redis.smembers('app:rooms');
    
    return {
      totalMessages: parseInt(totalMessages),
      totalRegisteredUsers: totalRegisteredUsers,
      activeRoomsCount: activeRooms.length,
      activeRoomsList: activeRooms, // GHI CHÚ: Dòng này đã được thêm vào
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Lỗi lấy thống kê:', error);
    return null;
  }
}

const socketRoomMap = {}; // Lưu trữ roomId mà mỗi socket đang tham gia
const socketUserMap = {}; // Lưu trữ userId của mỗi socket
const userIdSocketMap = {}; // Lưu trữ socketId của mỗi userId (cho chat riêng) - chỉ 1 socket/user

const ALL_ROOMS_KEY = 'app:rooms';
const ALL_ONLINE_USERS_KEY = 'app:onlineUsers'; // Tập hợp tất cả các userId đang online
const defaultRooms = ['Phòng Chung', 'Công Nghệ', 'Học Tập'];

async function initializeRooms() {
  try {
    console.log("Khởi tạo danh sách phòng...");
    // Chỉ thêm các phòng mặc định nếu chúng chưa tồn tại
    for (const room of defaultRooms) {
        await redis.sadd(ALL_ROOMS_KEY, room);
    }
    // Đảm bảo bộ đếm tin nhắn tổng thể được khởi tạo
    await redis.setnx('stats:totalMessages', 0); 
    console.log("✅ Danh sách phòng đã được cập nhật");
  } catch (err) {
    console.error("Lỗi khởi tạo phòng:", err);
  }
}

initializeRooms();

async function renewPresence(userId, roomId = 'global') {
  try {
    // Kéo dài thời gian tồn tại của userId trong tập hợp online users
    await redis.expire(ALL_ONLINE_USERS_KEY, USER_PRESENCE_TTL);

    // Nếu là chat phòng, cũng làm mới trạng thái trong phòng đó
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
    } else if (type === 'app' && targetId === 'onlineUsers' && updateType === 'update') {
      const onlineUserIds = JSON.parse(message);
      // Lấy thông tin chi tiết (bao gồm cả avatar) cho từng userId
      const onlineUsersDetails = [];
      for (const userId of onlineUserIds) {
          // Sử dụng hgetall để lấy toàn bộ thông tin user, bao gồm cả avatar
          const userProfile = await redis.hgetall(`user:${userId}`);
          if (userProfile && userProfile.username && userProfile.avatar) {
              onlineUsersDetails.push({
                  userId: userId,
                  username: userProfile.username,
                  avatar: userProfile.avatar
              });
          }
      }
      // Gửi danh sách chi tiết đến tất cả client
      io.emit('online users list', onlineUsersDetails);
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
      if (!validateUsername(username) || !validatePassword(password)) {
        return socket.emit('error', 'Tên đăng nhập hoặc mật khẩu không hợp lệ');
      }

      const result = await authenticateUser(username, password);
      if (result.error) {
        return socket.emit('error', result.error);
      }
      
      // Cập nhật socketId trong user profile và trạng thái online
      await redis.hset(`user:${result.userId}`, 'socketId', socketId, 'status', 'online');
      socket.data.userId = result.userId;
      socket.data.username = result.username;
      socketUserMap[socketId] = result.userId;
      userIdSocketMap[result.userId] = socketId; // Gán userId với socketId hiện tại

      // Thêm userId vào tập hợp online users toàn cầu
      await redis.sadd(ALL_ONLINE_USERS_KEY, result.userId);
      await renewPresence(result.userId); // Làm mới trạng thái online toàn cầu

      // Phát đi cập nhật danh sách người dùng online toàn cầu
      const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
      pubClient.publish('app:onlineUsers:update', JSON.stringify(onlineUserIds));

      socket.emit('auth_success', {
        userId: result.userId,
        token: result.token,
        username: result.username
      });
    } catch (error) {
      console.error('Lỗi đăng nhập:', error);
      socket.emit('error', 'Lỗi đăng nhập');
    }
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

      // Cập nhật socketId trong user profile và trạng thái online
      await redis.hset(`user:${decoded.userId}`, 'socketId', socketId, 'status', 'online');
      socket.data.userId = decoded.userId;
      socket.data.username = userProfile.username; // Sử dụng username từ profile
      socketUserMap[socketId] = decoded.userId;
      userIdSocketMap[decoded.userId] = socketId; // Gán userId với socketId hiện tại

      // Thêm userId vào tập hợp online users toàn cầu
      await redis.sadd(ALL_ONLINE_USERS_KEY, decoded.userId);
      await renewPresence(decoded.userId); // Làm mới trạng thái online toàn cầu

      // Lấy danh sách phòng và gửi về client
      const rooms = await redis.smembers(ALL_ROOMS_KEY);
      socket.emit('room list', rooms);

      // Đăng ký client vào kênh Pub/Sub để nhận cập nhật danh sách phòng và online users
      subClient.subscribe(`app:rooms:list_update`);
      subClient.subscribe(`app:onlineUsers:update`);

      // Phát đi cập nhật danh sách người dùng online toàn cầu
      const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
      pubClient.publish('app:onlineUsers:update', JSON.stringify(onlineUserIds));

      socket.emit('auth_verified', { username: userProfile.username, userId: decoded.userId });
    } catch (error) {
      console.error('Lỗi xác thực token:', error);
      socket.emit('error', 'Lỗi xác thực');
    }
  });

  // Tạo phòng chat mới
  socket.on('create room', async ({ roomName }) => {
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

      // Phát đi thông báo cập nhật danh sách phòng đến tất cả client qua Pub/Sub
      pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));
      
      socket.emit('room created', roomName); // Gửi xác nhận cho người tạo phòng
      console.log(`Phòng mới được tạo: ${roomName} bởi ${socket.data.username}`);

    } catch (error) {
      console.error('Lỗi tạo phòng:', error);
      socket.emit('error', 'Lỗi tạo phòng');
    }
  });

  // Tham gia vào một phòng chat
  socket.on('join room', async ({ roomId }) => {
    try {
      const { userId, username } = socket.data;
      if (!userId) {
        return socket.emit('error', 'Bạn chưa xác thực để tham gia phòng.');
      }

      const currentRoomId = socketRoomMap[socketId];
      
      // Nếu người dùng đã ở trong phòng này, không làm gì
      if (currentRoomId === roomId) {
        return;
      }

      // Rời khỏi phòng hiện tại nếu có
      if (currentRoomId) {
        socket.leave(currentRoomId);
        // Hủy đăng ký khỏi kênh Redis Pub/Sub của phòng cũ
        subClient.unsubscribe(`room:${currentRoomId}:updates`);

        const USER_ONLINE_IN_ROOM_KEY = `online:room:${currentRoomId}`;
        const PRESENCE_KEY_ROOM = `presence:user:${currentRoomId}:${userId}`;
        
        await redis.srem(USER_ONLINE_IN_ROOM_KEY, userId);
        await redis.del(PRESENCE_KEY_ROOM); // Xóa trạng thái online cũ trong phòng

        const oldOnlineUserIdsInRoom = await redis.smembers(USER_ONLINE_IN_ROOM_KEY);
        // Lấy username cho từng userId để gửi đến client
        const oldOnlineUsernamesInRoom = [];
        for (const uid of oldOnlineUserIdsInRoom) {
            const uname = await redis.hget(`user:${uid}`, 'username');
            if (uname) oldOnlineUsernamesInRoom.push(uname);
        }
        io.to(currentRoomId).emit('room online users', oldOnlineUsernamesInRoom);
        
        // Gửi thông báo người dùng rời phòng
        pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({
          user: 'Hệ thống',
          text: `${username} đã rời phòng.`,
          timestamp: Date.now(),
          isSystem: true
        }));
      }

      socket.join(roomId);
      socketRoomMap[socketId] = roomId;
      // Đăng ký client vào kênh Redis Pub/Sub của phòng mới
      subClient.subscribe(`room:${roomId}:updates`);

      const USER_ONLINE_IN_ROOM_KEY = `online:room:${roomId}`;
      await redis.sadd(USER_ONLINE_IN_ROOM_KEY, userId);
      // Đặt TTL cho tập hợp online users trong phòng
      await redis.expire(USER_ONLINE_IN_ROOM_KEY, 86400); // 1 ngày

      await renewPresence(userId, roomId); // Làm mới trạng thái online trong phòng

      await recordUserActivity(userId, roomId); // Ghi lại hoạt động

      const onlineUserIdsInRoom = await redis.smembers(USER_ONLINE_IN_ROOM_KEY);
      // Lấy username cho từng userId để gửi đến client
      const onlineUsernamesInRoom = [];
      for (const uid of onlineUserIdsInRoom) {
          const uname = await redis.hget(`user:${uid}`, 'username');
          if (uname) onlineUsernamesInRoom.push(uname);
      }
      io.to(roomId).emit('room online users', onlineUsernamesInRoom);

      const ROOM_HISTORY_KEY = `chat:room:${roomId}`;
      const history = await redis.lrange(ROOM_HISTORY_KEY, 0, MESSAGE_HISTORY_LIMIT - 1);
      // Đảo ngược thứ tự để hiển thị tin nhắn mới nhất ở dưới cùng
      const formattedHistory = history.map(msg => JSON.parse(msg)).reverse();
      socket.emit('history', formattedHistory);

      // Gửi thông báo người dùng đã tham gia phòng
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

  // Xử lý tin nhắn chat (phòng chung)
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

      // Kiểm tra giới hạn tốc độ gửi tin
      const allowed = await checkRateLimit(userId, 'room_message', roomId);
      if (!allowed) {
        return socket.emit('error', 'Bạn gửi tin quá nhanh. Hãy chờ một chút!');
      }

      const sanitizedText = sanitizeMessage(msg.text);

      await renewPresence(userId, roomId); // Làm mới trạng thái online trong phòng

      const ROOM_HISTORY_KEY = `chat:room:${roomId}`;
      const CHANNEL_NAME = `room:${roomId}:updates`; // Kênh Pub/Sub cho phòng này

      const messageObject = {
        user: username,
        text: sanitizedText,
        timestamp: Date.now(),
        userId: userId,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`
      };

      const messageString = JSON.stringify(messageObject);

      // Lưu tin nhắn vào lịch sử của phòng
      await redis.lpush(ROOM_HISTORY_KEY, messageString);
      await redis.ltrim(ROOM_HISTORY_KEY, 0, MESSAGE_HISTORY_LIMIT - 1); // Giữ giới hạn số lượng
      await redis.expire(ROOM_HISTORY_KEY, 604800); // Lịch sử tin nhắn tồn tại 7 ngày

      // Tăng bộ đếm tin nhắn tổng thể và cho người dùng
      await redis.incr('stats:totalMessages');
      await redis.hincrby(`user:${userId}`, 'messageCount', 1);

      // Phát tin nhắn đến tất cả các client trong phòng thông qua Redis Pub/Sub
      pubClient.publish(CHANNEL_NAME, messageString);

    } catch (error) {
      console.error('Lỗi gửi tin nhắn phòng:', error);
      socket.emit('error', 'Lỗi gửi tin nhắn phòng');
    }
  });

  // Xử lý tin nhắn riêng tư
  // Xử lý tin nhắn riêng tư
  socket.on('send private message', async ({ receiverUserId, text }) => {
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
        return socket.emit('error', 'Tin nhắn không hợp lệ (tối đa 1000 ký tự và không rỗng).');
      }

      // Kiểm tra giới hạn tốc độ gửi tin riêng
      const allowed = await checkRateLimit(senderUserId, 'private_message', receiverUserId);
      if (!allowed) {
        return socket.emit('error', 'Bạn gửi tin riêng quá nhanh. Hãy chờ một chút!');
      }

      const sanitizedText = sanitizeMessage(text);
      const receiverUsername = await redis.hget(`user:${receiverUserId}`, 'username');
      if (!receiverUsername) {
        return socket.emit('error', 'Người nhận không tồn tại.');
      }

      // Tạo khóa chat riêng tư (sắp xếp userId để đảm bảo duy nhất)
      const chatParticipants = [senderUserId, receiverUserId].sort();
      const PRIVATE_CHAT_KEY = `private_chat:${chatParticipants[0]}:${chatParticipants[1]}`;

      const messageObject = {
        senderId: senderUserId,
        senderUsername: senderUsername,
        receiverId: receiverUserId,
        receiverUsername: receiverUsername,
        text: sanitizedText,
        timestamp: Date.now(),
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${senderUsername}`
      };

      const messageString = JSON.stringify(messageObject);

      // 1. Lưu tin nhắn vào lịch sử chat riêng
      await redis.lpush(PRIVATE_CHAT_KEY, messageString);
      await redis.ltrim(PRIVATE_CHAT_KEY, 0, PRIVATE_CHAT_HISTORY_LIMIT - 1);
      await redis.expire(PRIVATE_CHAT_KEY, PRIVATE_CHAT_TTL);

      // 2. Cập nhật bộ đếm tin nhắn
      await redis.incr('stats:totalMessages');
      await redis.hincrby(`user:${senderUserId}`, 'messageCount', 1);

      // 3. Gửi lại tin nhắn cho chính người gửi (để cập nhật UI ngay lập tức)
      socket.emit('private message', messageObject);

      // 4. Kiểm tra xem người nhận có online không và gửi tin nhắn trực tiếp
      const receiverSocketId = userIdSocketMap[receiverUserId];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('private message', messageObject);
      }

      // Làm mới trạng thái online toàn cầu cho người gửi
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
      if (!senderUserId) {
        return socket.emit('error', 'Bạn cần đăng nhập để xem lịch sử chat riêng.');
      }

      // Tạo khóa chat riêng tư
      const chatParticipants = [senderUserId, targetUserId].sort();
      const PRIVATE_CHAT_KEY = `private_chat:${chatParticipants[0]}:${chatParticipants[1]}`;

      const history = await redis.lrange(PRIVATE_CHAT_KEY, 0, PRIVATE_CHAT_HISTORY_LIMIT - 1);
      const formattedHistory = history.map(msg => JSON.parse(msg)).reverse();
      socket.emit('private chat history', { targetUserId, history: formattedHistory });
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
          if (userProfile && getUserOnlineStatus(userId)) { // Chỉ thêm nếu socket còn đang kết nối
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
      const currentRoomId = socketRoomMap[socketId];
      const username = socket.data.username;
      const userId = socket.data.userId;

      console.log(`❌ Người dùng ngắt kết nối: ${socketId} (User: ${username || 'N/A'})`);

      if (userId) {
        // Xóa userId khỏi tập hợp online users toàn cầu
        await redis.srem(ALL_ONLINE_USERS_KEY, userId);
        // Cập nhật trạng thái người dùng thành offline
        await redis.hset(`user:${userId}`, 'status', 'offline');
        
        // Xóa khỏi map quản lý socket
        delete userIdSocketMap[userId];

        // Phát đi cập nhật danh sách người dùng online toàn cầu
        const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
        pubClient.publish('app:onlineUsers:update', JSON.stringify(onlineUserIds));

      }

      // Xử lý rời phòng chat chung
      if (currentRoomId && username) {
        const USER_ONLINE_IN_ROOM_KEY = `online:room:${currentRoomId}`;
        const PRESENCE_KEY_ROOM = `presence:user:${currentRoomId}:${userId}`;

        // Hủy đăng ký khỏi kênh Redis Pub/Sub của phòng
        subClient.unsubscribe(`room:${currentRoomId}:updates`);

        if (userId) { // Đảm bảo userId tồn tại trước khi xóa khỏi set
          await redis.srem(USER_ONLINE_IN_ROOM_KEY, userId); // Xóa khỏi danh sách online trong phòng
          await redis.del(PRESENCE_KEY_ROOM); // Xóa key presence trong phòng
        }
        

        // Gửi thông báo người dùng đã rời khỏi phòng
        pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({
          user: 'Hệ thống',
          text: `${username} đã rời khỏi phòng.`,
          timestamp: Date.now(),
          isSystem: true
        }));

        // Cập nhật danh sách người dùng online trong phòng
        const onlineUserIdsInRoom = await redis.smembers(USER_ONLINE_IN_ROOM_KEY);
        const onlineUsernamesInRoom = [];
        for (const uid of onlineUserIdsInRoom) {
            const uname = await redis.hget(`user:${uid}`, 'username');
            if (uname) onlineUsernamesInRoom.push(uname);
        }
        io.to(currentRoomId).emit('room online users', onlineUsernamesInRoom);
      }
      
      // Hủy đăng ký khỏi kênh cập nhật danh sách phòng chung
      subClient.unsubscribe(`app:rooms:list_update`);
      subClient.unsubscribe(`app:onlineUsers:update`);

      delete socketRoomMap[socketId];
      delete socketUserMap[socketId];
    } catch (error) {
      console.error('Lỗi ngắt kết nối:', error);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
  console.log(`📊 Ứng dụng Chat Redis đã khởi động`);
});