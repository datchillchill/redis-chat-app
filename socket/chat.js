const { v4: uuidv4 } = require('uuid');
function initializeChat(io, redis, pubClient, subClient, helpers) {
    const { 
        validateUsername, validatePassword, createUserProfile, authenticateUser,
        verifyToken, ALL_ONLINE_USERS_KEY, renewPresence, broadcastOnlineUsers,
        ALL_ROOMS_KEY, validateRoomName, socketRoomMap, socketUserMap, userIdSocketMap,
        getMessageContentPreview, validateMessage, checkRateLimit, sanitizeMessage,
        MESSAGE_RETENTION_SECONDS, PRIVATE_CHAT_TTL, defaultRooms,
        MESSAGE_HISTORY_LIMIT, PRIVATE_CHAT_HISTORY_LIMIT, JWT_SECRET,
        uuidv4, bcrypt
    } = helpers;

    io.on('connection', (socket) => {
        // Xử lý kết nối của Admin
        if (socket.isAdmin) {
            console.log(`🔑 Admin đã kết nối: ${socket.id}`);
            socket.join('admins');
            return;
        } 
        // Xử lý kết nối của người dùng thông thường
        else {
            const socketId = socket.id;
            console.log(`✅ Người dùng mới kết nối: ${socketId}`);

            socket.on('register', async ({ username, password }) => {
                try {
                    if (!validateUsername(username)) return socket.emit('error', 'Tên người dùng không hợp lệ.');
                    if (!validatePassword(password)) return socket.emit('error', 'Mật khẩu phải có ít nhất 6 ký tự.');
                    const result = await createUserProfile(username, password, socketId);
                    if (result.error) return socket.emit('error', result.error);
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
                    const result = await authenticateUser(username, password);
                    if (result.error) return socket.emit('error', result.error);
                    
                    await redis.hset(`user:${result.userId}`, 'socketId', socketId, 'status', 'online');
                    socket.data.userId = result.userId;
                    socket.data.username = result.username;
                    socketUserMap[socketId] = result.userId;
                    userIdSocketMap[result.userId] = socketId;
                    socket.join(result.userId);

                    await redis.sadd(ALL_ONLINE_USERS_KEY, result.userId);
                    await renewPresence(result.userId);
                    broadcastOnlineUsers();
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
                    const userProfile = await redis.hgetall(`user:${decoded.userId}`);
                    if (!userProfile) return socket.emit('error', 'Người dùng không tồn tại.');

                    await redis.hset(`user:${decoded.userId}`, 'socketId', socketId, 'status', 'online');
                    socket.data.userId = decoded.userId;
                    socket.data.username = userProfile.username;
                    socketUserMap[socketId] = decoded.userId;
                    userIdSocketMap[decoded.userId] = socketId;
                    socket.join(decoded.userId);

                    await redis.sadd(ALL_ONLINE_USERS_KEY, decoded.userId);
                    await renewPresence(decoded.userId);

                    const rooms = await redis.smembers(ALL_ROOMS_KEY);
                    socket.emit('room list', rooms);
                    
                    subClient.subscribe(`app:rooms:list_update`);
                    
                    broadcastOnlineUsers();
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
                    if (await redis.sismember(ALL_ROOMS_KEY, roomName)) return socket.emit('error', 'Phòng đã tồn tại.');
                    
                    await redis.sadd(ALL_ROOMS_KEY, roomName);
                    const updatedRooms = await redis.smembers(ALL_ROOMS_KEY);
                    
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
                        await redis.srem(`online:room:${currentRoomId}`, userId);
                        pubClient.publish(`room:${currentRoomId}:updates`, JSON.stringify({ user: 'Hệ thống', text: `${username} đã rời phòng.`, timestamp: Date.now(), isSystem: true }));
                    }

                    socket.join(roomId);
                    await redis.hdel(`unread_counts:${userId}`, roomId);
                    socket.emit('unread_update', { chatId: roomId, count: 0 });
                    socketRoomMap[socket.id] = roomId;
                    subClient.subscribe(`room:${roomId}:updates`);

                    await redis.sadd(`online:room:${roomId}`, userId);
                    await renewPresence(userId, roomId);
                    
                    const messageIds = await redis.zrange(`order:${roomId}`, -MESSAGE_HISTORY_LIMIT, -1);
                    if (messageIds.length > 0) {
                        const historyMessages = await redis.hmget(`messages:${roomId}`, ...messageIds);
                        socket.emit('history', historyMessages.filter(msg => msg).map(msg => JSON.parse(msg)));
                    } else {
                        socket.emit('history', []);
                    }
                    
                    pubClient.publish(`room:${roomId}:updates`, JSON.stringify({ user: 'Hệ thống', text: `${username} đã tham gia phòng.`, timestamp: Date.now(), isSystem: true }));
                } catch (error) {
                    console.error('Lỗi tham gia phòng:', error);
                    socket.emit('error', 'Lỗi tham gia phòng');
                }
            });
            // Xử lý gửi tin nhắn trong phòng
            socket.on('chat message', async (msg) => {
                try {
                    const roomId = socketRoomMap[socketId];
                    const { username, userId } = socket.data;
                    if (!roomId || !username) return socket.emit('error', 'Bạn chưa tham gia phòng.');
                    if (!validateMessage(msg.text || '') && !msg.file) return socket.emit('error', 'Nội dung không hợp lệ.');
                    if (!(await checkRateLimit(userId, 'room_message', roomId))) return socket.emit('error', 'Bạn gửi tin quá nhanh!');

                    const sanitizedText = msg.text ? sanitizeMessage(msg.text) : '';
                    await renewPresence(userId, roomId);

                    const MESSAGES_HASH_KEY = `messages:${roomId}`;
                    let replyToObject = null;
                    if (msg.replyTo && msg.replyTo.messageId) {
                        const originalMessageString = await redis.hget(MESSAGES_HASH_KEY, msg.replyTo.messageId);
                        if (originalMessageString) {
                            const originalMessage = JSON.parse(originalMessageString);
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
                    const messageString = JSON.stringify(messageObject);

                    const pipeline = redis.pipeline();
                    pipeline.hset(MESSAGES_HASH_KEY, messageId, messageString);
                    pipeline.zadd(`order:${roomId}`, timestamp, messageId);
                    pipeline.expire(MESSAGES_HASH_KEY, MESSAGE_RETENTION_SECONDS);
                    pipeline.expire(`order:${roomId}`, MESSAGE_RETENTION_SECONDS);
                    if (msg.replyTo && msg.replyTo.messageId) {
                        pipeline.sadd(`replies_to:${msg.replyTo.messageId}`, messageId).expire(`replies_to:${msg.replyTo.messageId}`, MESSAGE_RETENTION_SECONDS);
                    }
                    await pipeline.exec();
                    
                    await redis.incr('stats:totalMessages');
                    await redis.hincrby(`user:${userId}`, 'messageCount', 1);
                    io.to('admins').emit('admin_users_updated');

                    pubClient.publish(`room:${roomId}:updates`, messageString);
                    const onlineUserIds = await redis.smembers(ALL_ONLINE_USERS_KEY);
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
            socket.on('send private message', async (data) => {
                try {
                    const { receiverUserId, text, replyTo, file } = data;
                    const senderUserId = socket.data.userId;
                    const senderUsername = socket.data.username;

                    if (!senderUserId || !senderUsername) return socket.emit('error', 'Bạn cần đăng nhập.');
                    if (senderUserId === receiverUserId) return socket.emit('error', 'Bạn không thể tự nhắn tin cho mình.');
                    if (!validateMessage(text || '') && !file) return socket.emit('error', 'Nội dung không hợp lệ.');
                    
                    const sanitizedText = text ? sanitizeMessage(text) : '';
                    const receiverUsername = await redis.hget(`user:${receiverUserId}`, 'username');
                    if (!receiverUsername) return socket.emit('error', 'Người nhận không tồn tại.');

                    const chatParticipants = [senderUserId, receiverUserId].sort();
                    const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
                    const MESSAGES_HASH_KEY = `messages:${privateChatId}`;

                    let replyToObject = null;
                    if (replyTo && replyTo.messageId) {
                        const originalMessageString = await redis.hget(MESSAGES_HASH_KEY, replyTo.messageId);
                        if (originalMessageString) {
                            const originalMessage = JSON.parse(originalMessageString);
                            const originalUser = originalMessage.user || originalMessage.senderUsername;
                            if (originalUser && (originalMessage.text || originalMessage.file)) {
                                const previewText = getMessageContentPreview(originalMessage);
                                replyToObject = { messageId: originalMessage.messageId, user: originalUser, text: previewText.substring(0, 75) + (previewText.length > 75 ? '...' : '') };
                            }
                        }
                    }
                    
                    const messageId = uuidv4();
                    const timestamp = Date.now();
                    const messageObject = { messageId, senderId: senderUserId, senderUsername, receiverId: receiverUserId, receiverUsername, text: sanitizedText, timestamp, avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${senderUsername}`, reactions: {}, replyTo: replyToObject, file: file || null };
                    const messageString = JSON.stringify(messageObject);

                    const pipeline = redis.pipeline();
                    pipeline.hset(MESSAGES_HASH_KEY, messageId, messageString);
                    pipeline.zadd(`order:${privateChatId}`, timestamp, messageId);
                    pipeline.expire(MESSAGES_HASH_KEY, PRIVATE_CHAT_TTL);
                    pipeline.expire(`order:${privateChatId}`, PRIVATE_CHAT_TTL);
                    if (replyTo && replyTo.messageId) {
                        pipeline.sadd(`replies_to:${replyTo.messageId}`, messageId).expire(`replies_to:${replyTo.messageId}`, PRIVATE_CHAT_TTL);
                    }
                    await pipeline.exec();

                    await redis.incr('stats:totalMessages');
                    await redis.hincrby(`user:${senderUserId}`, 'messageCount', 1);
                    io.to('admins').emit('admin_users_updated');
                    
                    // Gửi tin nhắn đến cả người gửi và người nhận
                    socket.emit('private message', messageObject);
                    io.to(receiverUserId).emit('private message', messageObject);
                    
                    // Gửi thông báo chưa đọc và KÍCH HOẠT THÔNG BÁO POPUP
                    const receiverSocketId = userIdSocketMap[receiverUserId];
                    let isReceiverInChat = false;
                    if (receiverSocketId && io.sockets.sockets.get(receiverSocketId)) {
                        const receiverSocket = io.sockets.sockets.get(receiverSocketId);
                        const receiverCurrentChatId = receiverSocket.handshake.query.currentChatId; // Giả sử client gửi thông tin này
                        if (receiverCurrentChatId === privateChatId) {
                            isReceiverInChat = true;
                        }
                    }

                    // Chỉ gửi thông báo nếu người nhận không ở trong cuộc trò chuyện đó
                    if (!isReceiverInChat) {
                        // Gửi thông báo chưa đọc
                        const newCount = await redis.hincrby(`unread_counts:${receiverUserId}`, privateChatId, 1);
                        io.to(receiverUserId).emit('unread_update', { chatId: privateChatId, count: newCount });
                        // Gửi sự kiện để kích hoạt âm thanh/popup
                        io.to(receiverUserId).emit('new_message_notification', messageObject);
                    }

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

            // Xử lý khi người dùng ngắt kết nối
            socket.on('disconnect', async () => {
                    try {
                        const userId = socket.data.userId;
                        const username = socket.data.username;
                        if (!userId || !username) return;

                        console.log(`❌ Người dùng ngắt kết nối: ${socketId} (User: ${username})`);
                        
                        // Logic kiểm tra multi-tab
                        setTimeout(async () => {
                            const userSockets = io.sockets.adapter.rooms.get(userId);
                            if (!userSockets || userSockets.size === 0) {
                                console.log(`User ${username} is now fully offline.`);
                                await redis.srem(ALL_ONLINE_USERS_KEY, userId);
                                await redis.hset(`user:${userId}`, 'status', 'offline');
                                broadcastOnlineUsers();
                            }
                        }, 500);

                        const currentRoomId = socketRoomMap[socketId];
                        if (currentRoomId) {
                            subClient.unsubscribe(`room:${currentRoomId}:updates`);
                            await redis.srem(`online:room:${currentRoomId}`, userId);
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
            });
        } 
    });
}

module.exports = initializeChat;