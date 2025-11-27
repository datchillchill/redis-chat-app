const { v4: uuidv4 } = require('uuid');
const { redis, pubClient, subClient } = require('../config/redis');
const {
    ALL_ONLINE_USERS_KEY, ALL_ROOMS_KEY, MESSAGE_RETENTION_SECONDS,
    PRIVATE_CHAT_TTL, MESSAGE_HISTORY_LIMIT, PRIVATE_CHAT_HISTORY_LIMIT
} = require('../config/constants');
const {
    validateUsername, validatePassword, validateRoomName, validateMessage,
    sanitizeMessage, getMessageContentPreview, verifyToken
} = require('../utils/helpers');
const userRepo = require('../repositories/userRepository');
const roomRepo = require('../repositories/roomRepository');
const messageRepo = require('../repositories/messageRepository');
const authService = require('../services/authService');

const adminWatchingMap = {};
const socketRoomMap = {};
const socketUserMap = {};
const userIdSocketMap = {};

async function checkRateLimit(userId, type = 'message', targetId = 'global') {
    const RATE_LIMIT_WINDOW = 60;
    const RATE_LIMIT_MESSAGES = 10;
    const RATE_KEY = `rate:${type}:${userId}:${targetId}`;
    const count = await redis.incr(RATE_KEY);
    if (count === 1) await redis.expire(RATE_KEY, RATE_LIMIT_WINDOW);
    return count <= RATE_LIMIT_MESSAGES;
}

async function renewPresence(userId, roomId = 'global') {
    const USER_PRESENCE_TTL = 15;
    if (roomId !== 'global') {
        await redis.setex(`presence:user:${roomId}:${userId}`, USER_PRESENCE_TTL, '1');
    }
}

async function broadcastOnlineUsers(io) {
    const onlineUserIds = await userRepo.getOnlineUserIds(ALL_ONLINE_USERS_KEY);
    const onlineUsersDetails = [];
    for (const userId of onlineUserIds) {
        const userProfile = await userRepo.findUserById(userId);
        if (userProfile && userProfile.username) {
            onlineUsersDetails.push({ userId: userProfile.userId, username: userProfile.username, avatar: userProfile.avatar });
        }
    }
    io.emit('online users list', onlineUsersDetails);
}

function initializeChat(io) {
    // Redis Subscriber Logic
    subClient.on('message', (channel, message) => {
        try {
            const msg = JSON.parse(message);
            if (channel === 'app:rooms:list_update') {
                io.emit('room list', msg);
            } else if (channel.startsWith('room:') && channel.endsWith(':updates')) {
                const roomId = channel.split(':')[1];
                if (msg.type === 'delete') {
                    io.to(roomId).emit('message deleted', { messageId: msg.messageId });
                } else if (msg.type === 'edit') {
                    io.to(roomId).emit('message edited', msg);
                } else if (msg.type === 'reaction') {
                    io.to(roomId).emit('message reacted', msg);
                } else {
                    io.to(roomId).emit('chat message', msg);
                }
            }
        } catch (err) {
            console.error('Redis sub error:', err);
        }
    });

    io.on('connection', (socket) => {
        const socketId = socket.id;
        if (socket.isAdmin) {
            console.log(`Admin đã kết nối: ${socket.id}`);
            socket.join('admins');

            socket.on('admin_watch_chat', ({ chatId }) => {
                console.log(`Admin ${socket.id} đang theo dõi ${chatId}`);
                adminWatchingMap[socket.id] = chatId;
            });

            socket.on('admin_stop_watching_chat', () => {
                if (adminWatchingMap[socket.id]) {
                    console.log(`Admin ${socket.id} đã ngừng theo dõi ${adminWatchingMap[socket.id]}`);
                    delete adminWatchingMap[socket.id];
                }
            });

        } else {
            console.log(`Người dùng mới kết nối: ${socketId}`);

            socket.on('register', async ({ username, password }) => {
                try {
                    if (!validateUsername(username)) return socket.emit('error', 'Tên người dùng không hợp lệ.');
                    if (!validatePassword(password)) return socket.emit('error', 'Mật khẩu phải có ít nhất 6 ký tự.');

                    const result = await authService.register(username, password, socketId);
                    if (result.error) return socket.emit('error', result.error);

                    io.to('admins').emit('admin_users_updated');
                    socket.emit('auth_success', { userId: result.userId, token: result.token, username: username });
                } catch (error) {
                    console.error('Lỗi đăng ký:', error);
                    socket.emit('error', 'Lỗi đăng ký');
                }
            });

            socket.on('login', async ({ username, password }) => {
                try {
                    if (!validateUsername(username) || !validatePassword(password)) {
                        return socket.emit('error', 'Dữ liệu không hợp lệ.');
                    }
                    const result = await authService.login(username, password);
                    if (result.error) return socket.emit('error', result.error);

                    await userRepo.updateUserStatus(result.userId, socketId, 'online');
                    socket.data.userId = result.userId;
                    socket.data.username = result.username;
                    socketUserMap[socketId] = result.userId;
                    userIdSocketMap[result.userId] = socketId;
                    socket.join(result.userId);

                    await userRepo.addOnlineUser(ALL_ONLINE_USERS_KEY, result.userId);
                    await renewPresence(result.userId);
                    broadcastOnlineUsers(io);
                    io.to('admins').emit('admin_users_updated');
                    socket.emit('auth_success', { userId: result.userId, token: result.token, username: result.username });
                } catch (error) {
                    console.error('Lỗi đăng nhập:', error);
                    socket.emit('error', 'Lỗi đăng nhập');
                }
            });

            socket.on('authenticate', async ({ token }) => {
                try {
                    const decoded = verifyToken(token);
                    if (!decoded) return socket.emit('error', 'Token không hợp lệ.');
                    const userProfile = await userRepo.findUserById(decoded.userId);
                    if (!userProfile) return socket.emit('error', 'Người dùng không tồn tại.');

                    await userRepo.updateUserStatus(decoded.userId, socketId, 'online');
                    socket.data.userId = decoded.userId;
                    socket.data.username = userProfile.username;
                    socketUserMap[socketId] = decoded.userId;
                    userIdSocketMap[decoded.userId] = socketId;
                    socket.join(decoded.userId);

                    await userRepo.addOnlineUser(ALL_ONLINE_USERS_KEY, decoded.userId);
                    await renewPresence(decoded.userId);

                    const rooms = await roomRepo.getAllRooms();
                    socket.emit('room list', rooms);

                    subClient.subscribe(`app:rooms:list_update`);

                    broadcastOnlineUsers(io);
                    io.to('admins').emit('admin_users_updated');
                    const unreadCounts = await redis.hgetall(`unread_counts:${decoded.userId}`);
                    socket.emit('all_unread_counts', unreadCounts);
                    socket.emit('auth_verified', { username: userProfile.username, userId: decoded.userId });
                } catch (error) {
                    console.error('Lỗi xác thực token:', error);
                    socket.emit('error', 'Lỗi xác thực');
                }
            });

            socket.on('create room', async ({ roomName }) => {
                try {
                    if (!socket.data.userId) return socket.emit('error', 'Bạn cần đăng nhập.');
                    if (!validateRoomName(roomName)) return socket.emit('error', 'Tên phòng không hợp lệ.');
                    if (await roomRepo.checkRoomExists(roomName)) return socket.emit('error', 'Phòng đã tồn tại.');

                    await roomRepo.addRoom(roomName);
                    const updatedRooms = await roomRepo.getAllRooms();

                    pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));
                    io.to('admins').emit('admin_rooms_updated');
                    socket.emit('room created', roomName);
                } catch (error) {
                    console.error('Lỗi tạo phòng:', error);
                    socket.emit('error', 'Lỗi tạo phòng');
                }
            });

            socket.on('join room', async ({ roomId }) => {
                try {
                    const { userId, username } = socket.data;
                    if (!userId) return socket.emit('error', 'Bạn chưa xác thực.');

                    const currentRoomId = socketRoomMap[socket.id];
                    if (currentRoomId && currentRoomId !== roomId) {
                        socket.leave(currentRoomId);
                        subClient.unsubscribe(`room:${currentRoomId}:updates`);
                        await userRepo.removeOnlineUser(`online:room:${currentRoomId}`, userId);
                        pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({ user: 'Hệ thống', text: `${username} đã rời phòng.`, timestamp: Date.now(), isSystem: true }));
                    }

                    socket.join(roomId);
                    await redis.hdel(`unread_counts:${userId}`, roomId);
                    socket.emit('unread_update', { chatId: roomId, count: 0 });
                    socketRoomMap[socket.id] = roomId;
                    subClient.subscribe(`room:${roomId}:updates`);

                    await userRepo.addOnlineUser(`online:room:${roomId}`, userId);
                    await renewPresence(userId, roomId);

                    const historyMessages = await messageRepo.getHistory(roomId, MESSAGE_HISTORY_LIMIT);
                    socket.emit('history', historyMessages);

                    // Check for pinned message
                    const pinnedMessage = await redis.get(`pinned_message:${roomId}`);
                    if (pinnedMessage) {
                        socket.emit('message_pinned', { chatId: roomId, pinnedMessage: JSON.parse(pinnedMessage) });
                    } else {
                        socket.emit('message_pinned', { chatId: roomId, pinnedMessage: null });
                    }

                    pubClient.publish(`room:${roomId}:updates`, JSON.stringify({ user: 'Hệ thống', text: `${username} đã tham gia phòng.`, timestamp: Date.now(), isSystem: true }));
                } catch (error) {
                    console.error('Lỗi tham gia phòng:', error);
                    socket.emit('error', 'Lỗi tham gia phòng');
                }
            });

            socket.on('chat message', async (msg) => {
                try {
                    const roomId = socketRoomMap[socketId];
                    const { username, userId } = socket.data;
                    if (!roomId || !username) return socket.emit('error', 'Bạn chưa tham gia phòng.');
                    if (!validateMessage(msg.text || '') && !msg.file) return socket.emit('error', 'Nội dung không hợp lệ.');
                    if (!(await checkRateLimit(userId, 'room_message', roomId))) return socket.emit('error', 'Bạn gửi tin quá nhanh!');

                    const sanitizedText = msg.text ? sanitizeMessage(msg.text) : '';
                    await renewPresence(userId, roomId);

                    let replyToObject = null;
                    if (msg.replyTo && msg.replyTo.messageId) {
                        const originalMessage = await messageRepo.getMessage(roomId, msg.replyTo.messageId);
                        if (originalMessage) {
                            const originalUser = originalMessage.user || originalMessage.senderUsername;
                            if (originalUser && (originalMessage.text || originalMessage.file)) {
                                const previewText = getMessageContentPreview(originalMessage);
                                replyToObject = { messageId: originalMessage.messageId, user: originalUser, text: previewText.substring(0, 75) + (previewText.length > 75 ? '...' : '') };
                            }
                        }
                    }

                    const messageId = uuidv4();
                    const timestamp = Date.now();
                    const messageObject = { messageId, roomId, user: username, text: sanitizedText, timestamp, userId, avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`, reactions: {}, replyTo: replyToObject, file: msg.file || null };

                    await messageRepo.saveMessage(roomId, messageId, messageObject, timestamp);

                    await redis.incr('stats:totalMessages');
                    await userRepo.incrementMessageCount(userId);
                    io.to('admins').emit('admin_users_updated');

                    pubClient.publish(`room:${roomId}:updates`, JSON.stringify(messageObject));

                    for (const adminSocketId in adminWatchingMap) {
                        if (adminWatchingMap[adminSocketId] === roomId) {
                            io.to(adminSocketId).emit('admin_new_message', messageObject);
                        }
                    }
                    const onlineUserIds = await userRepo.getOnlineUserIds(ALL_ONLINE_USERS_KEY);
                    for (const onlineUserId of onlineUserIds) {
                        if (onlineUserId !== userId) {
                            const userSocketId = userIdSocketMap[onlineUserId];
                            if (!userSocketId || socketRoomMap[userSocketId] !== roomId) {
                                const newCount = await redis.hincrby(`unread_counts:${onlineUserId}`, roomId, 1);
                                io.to(onlineUserId).emit('unread_update', { chatId: roomId, count: newCount });
                                io.to(onlineUserId).emit('new_message_notification', messageObject);
                            }
                        }
                    }

                } catch (error) {
                    console.error('Lỗi gửi tin nhắn phòng:', error);
                    socket.emit('error', 'Lỗi gửi tin nhắn phòng');
                }
            });

            socket.on('edit message', async ({ messageId, newText, chatId }) => {
                try {
                    const { userId } = socket.data;
                    if (!userId) return;
                    if (!validateMessage(newText)) return socket.emit('error', 'Nội dung không hợp lệ.');

                    const message = await messageRepo.getMessage(chatId, messageId);
                    if (!message) return socket.emit('error', 'Tin nhắn không tồn tại.');
                    const messageOwnerId = message.userId || message.senderId;
                    if (messageOwnerId !== userId) return socket.emit('error', 'Bạn chỉ có thể sửa tin nhắn của mình.');
                    if (message.isDeleted) return socket.emit('error', 'Không thể sửa tin nhắn đã xóa.');

                    message.text = sanitizeMessage(newText);
                    message.edited = true;
                    await messageRepo.updateMessage(chatId, messageId, message);

                    const updatePayload = JSON.stringify({ ...message, type: 'edit' });
                    if (chatId.startsWith('private:')) {
                        const parts = chatId.split(':');
                        const receiverId = parts[1] === userId ? parts[2] : parts[1];
                        io.to(receiverId).emit('message edited', message);
                        socket.emit('message edited', message);
                    } else {
                        pubClient.publish(`room:${chatId}:updates`, updatePayload);
                    }
                } catch (error) {
                    console.error('Lỗi sửa tin nhắn:', error);
                }
            });

            socket.on('delete message', async ({ messageId, chatId }) => {
                try {
                    const { userId } = socket.data;
                    if (!userId) return;

                    const message = await messageRepo.getMessage(chatId, messageId);
                    if (!message) return socket.emit('error', 'Tin nhắn không tồn tại.');
                    const messageOwnerId = message.userId || message.senderId;
                    if (messageOwnerId !== userId) return socket.emit('error', 'Bạn chỉ có thể xóa tin nhắn của mình.');

                    await messageRepo.deleteMessage(chatId, messageId);

                    const deletePayload = JSON.stringify({ messageId, chatId, type: 'delete' });
                    if (chatId.startsWith('private:')) {
                        const parts = chatId.split(':');
                        const receiverId = parts[1] === userId ? parts[2] : parts[1];
                        io.to(receiverId).emit('message deleted', { messageId, chatId });
                        socket.emit('message deleted', { messageId, chatId });
                    } else {
                        pubClient.publish(`room:${chatId}:updates`, deletePayload);
                    }
                } catch (error) {
                    console.error('Lỗi xóa tin nhắn:', error);
                }
            });

            socket.on('react to message', async ({ messageId, emoji, chatId }) => {
                try {
                    const { userId, username } = socket.data;
                    if (!userId) return;

                    const message = await messageRepo.getMessage(chatId, messageId);
                    if (!message) return;

                    if (!message.reactions) message.reactions = {};
                    if (!message.reactions[emoji]) message.reactions[emoji] = [];

                    if (!message.reactions[emoji].includes(username)) {
                        message.reactions[emoji].push(username);
                    } else {
                        message.reactions[emoji] = message.reactions[emoji].filter(u => u !== username);
                        if (message.reactions[emoji].length === 0) delete message.reactions[emoji];
                    }

                    await messageRepo.updateMessage(chatId, messageId, message);

                    if (chatId.startsWith('private:')) {
                        const parts = chatId.split(':');
                        const receiverId = parts[1] === userId ? parts[2] : parts[1];
                        io.to(receiverId).emit('message reacted', message);
                        socket.emit('message reacted', message);
                    } else {
                        pubClient.publish(`room:${chatId}:updates`, JSON.stringify({ ...message, type: 'reaction' }));
                    }
                } catch (error) {
                    console.error('Lỗi reaction:', error);
                }
            });

            socket.on('send private message', async (msg) => {
                try {
                    const { userId, username } = socket.data;
                    if (!userId) return socket.emit('error', 'Chưa đăng nhập.');
                    const receiverId = msg.receiverUserId;
                    if (!receiverId) return socket.emit('error', 'Người nhận không hợp lệ.');

                    if (!validateMessage(msg.text || '') && !msg.file) return socket.emit('error', 'Nội dung không hợp lệ.');
                    if (!(await checkRateLimit(userId, 'private_message', receiverId))) return socket.emit('error', 'Bạn gửi tin quá nhanh!');

                    const chatParticipants = [userId, receiverId].sort();
                    const chatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;

                    const sanitizedText = msg.text ? sanitizeMessage(msg.text) : '';

                    let replyToObject = null;
                    if (msg.replyTo && msg.replyTo.messageId) {
                        const originalMessage = await messageRepo.getMessage(chatId, msg.replyTo.messageId);
                        if (originalMessage) {
                            const originalUser = originalMessage.user || originalMessage.senderUsername;
                            const previewText = getMessageContentPreview(originalMessage);
                            replyToObject = { messageId: originalMessage.messageId, user: originalUser, text: previewText.substring(0, 75) + (previewText.length > 75 ? '...' : '') };
                        }
                    }

                    const messageId = uuidv4();
                    const timestamp = Date.now();
                    const messageObject = {
                        messageId,
                        senderId: userId,
                        receiverId: receiverId,
                        senderUsername: username,
                        text: sanitizedText,
                        timestamp,
                        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
                        reactions: {},
                        replyTo: replyToObject,
                        file: msg.file || null
                    };

                    await messageRepo.saveMessage(chatId, messageId, messageObject, timestamp);
                    await userRepo.incrementMessageCount(userId);
                    io.to('admins').emit('admin_users_updated');

                    socket.emit('private message', messageObject);
                    io.to(receiverId).emit('private message', messageObject);

                    await redis.hincrby(`unread_counts:${receiverId}`, chatId, 1);
                    const newCount = await redis.hget(`unread_counts:${receiverId}`, chatId);
                    io.to(receiverId).emit('unread_update', { chatId, count: parseInt(newCount) });
                    io.to(receiverId).emit('new_message_notification', messageObject);

                    for (const adminSocketId in adminWatchingMap) {
                        if (adminWatchingMap[adminSocketId] === chatId) {
                            io.to(adminSocketId).emit('admin_new_message', messageObject);
                        }
                    }

                } catch (error) {
                    console.error('Lỗi gửi tin nhắn riêng:', error);
                    socket.emit('error', 'Lỗi gửi tin nhắn riêng');
                }
            });

            socket.on('get private history', async ({ targetUserId }) => {
                try {
                    const { userId } = socket.data;
                    if (!userId) return;
                    const chatParticipants = [userId, targetUserId].sort();
                    const chatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;

                    const history = await messageRepo.getHistory(chatId, PRIVATE_CHAT_HISTORY_LIMIT);
                    socket.emit('private chat history', { history, partnerId: targetUserId });

                    await redis.hdel(`unread_counts:${userId}`, chatId);
                    socket.emit('unread_update', { chatId, count: 0 });

                    // Check for pinned message
                    const pinnedMessage = await redis.get(`pinned_message:${chatId}`);
                    if (pinnedMessage) {
                        socket.emit('message_pinned', { chatId, pinnedMessage: JSON.parse(pinnedMessage) });
                    } else {
                        socket.emit('message_pinned', { chatId, pinnedMessage: null });
                    }
                } catch (error) {
                    console.error('Lỗi lấy lịch sử chat riêng:', error);
                }
            });

            socket.on('mark_as_read', async ({ chatId }) => {
                try {
                    const { userId } = socket.data;
                    if (!userId || !chatId) return;
                    await redis.hdel(`unread_counts:${userId}`, chatId);
                    socket.emit('unread_update', { chatId, count: 0 });
                } catch (error) {
                    console.error('Lỗi đánh dấu đã xem:', error);
                }
            });

            socket.on('pin_message', async ({ messageId, chatId }) => {
                try {
                    const message = await messageRepo.getMessage(chatId, messageId);
                    if (message) {
                        await redis.set(`pinned_message:${chatId}`, JSON.stringify(message));
                        if (chatId.startsWith('private:')) {
                            const parts = chatId.split(':');
                            const u1 = parts[1];
                            const u2 = parts[2];
                            io.to(u1).emit('message_pinned', { chatId, pinnedMessage: message });
                            io.to(u2).emit('message_pinned', { chatId, pinnedMessage: message });
                        } else {
                            io.to(chatId).emit('message_pinned', { chatId, pinnedMessage: message });
                        }
                    }
                } catch (error) {
                    console.error('Lỗi ghim tin nhắn:', error);
                }
            });

            socket.on('start_typing', ({ chatId }) => {
                const { username } = socket.data;
                if (chatId.startsWith('private:')) {
                    const parts = chatId.split(':');
                    const u1 = parts[1];
                    const u2 = parts[2];
                    const receiverId = u1 === socket.data.userId ? u2 : u1;
                    io.to(receiverId).emit('user_typing', { username, chatId });
                } else {
                    socket.to(chatId).emit('user_typing', { username, chatId });
                }
            });

            socket.on('stop_typing', ({ chatId }) => {
                const { username } = socket.data;
                if (chatId.startsWith('private:')) {
                    const parts = chatId.split(':');
                    const u1 = parts[1];
                    const u2 = parts[2];
                    const receiverId = u1 === socket.data.userId ? u2 : u1;
                    io.to(receiverId).emit('user_stopped_typing', { username, chatId });
                } else {
                    socket.to(chatId).emit('user_stopped_typing', { username, chatId });
                }
            });

            socket.on('get full history', async ({ chatId }, callback) => {
                try {
                    const history = await messageRepo.getHistory(chatId, 1000);
                    callback(history);
                } catch (error) {
                    console.error('Lỗi lấy toàn bộ lịch sử:', error);
                    callback([]);
                }
            });

            socket.on('disconnect', async () => {
                if (socket.isAdmin) {
                    console.log(`Admin đã ngắt kết nối: ${socketId}`);
                    delete adminWatchingMap[socketId];
                } else {
                    try {
                        const userId = socket.data.userId;
                        const username = socket.data.username;
                        if (!userId || !username) return;

                        console.log(`Người dùng ngắt kết nối: ${socketId} (User: ${username})`);

                        setTimeout(async () => {
                            const userSockets = io.sockets.adapter.rooms.get(userId);
                            if (!userSockets || userSockets.size === 0) {
                                console.log(`User ${username} is now fully offline.`);
                                await userRepo.removeOnlineUser(ALL_ONLINE_USERS_KEY, userId);
                                await userRepo.updateUserStatus(userId, socketId, 'offline');
                                broadcastOnlineUsers(io);
                                io.to('admins').emit('admin_users_updated');
                            }
                        }, 500);

                        const currentRoomId = socketRoomMap[socketId];
                        if (currentRoomId) {
                            subClient.unsubscribe(`room:${currentRoomId}:updates`);
                            await userRepo.removeOnlineUser(`online:room:${currentRoomId}`, userId);
                            pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({ user: 'Hệ thống', text: `${username} đã rời khỏi phòng.`, timestamp: Date.now(), isSystem: true }));
                        }

                        delete socketRoomMap[socketId];
                        delete socketUserMap[socketId];
                        if (userIdSocketMap[userId] === socketId) {
                            delete userIdSocketMap[userId];
                        }
                    } catch (error) {
                        console.error('Lỗi ngắt kết nối:', error);
                    }
                }
            });
        }
    });
}

module.exports = { initializeChat };
