const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const fs = require('fs');


function adminRoutes(app, redis, JWT_SECRET, defaultRooms, ALL_ROOMS_KEY, io, pubClient, ALL_ONLINE_USERS_KEY) {
    const ADMIN_USER = 'admin';
    const ADMIN_PASS = 'admin123';
    const ADMIN_TOKEN_SECRET = JWT_SECRET + '-admin';

    app.use('/admin', cookieParser());

    // Middleware: "Người gác cổng" kiểm tra token admin
    function verifyAdminTokenMiddleware(req, res, next) {
        const token = req.cookies.admin_token;
        if (!token) {
            return res.redirect('/admin-login.html');
        }
        try {
            jwt.verify(token, ADMIN_TOKEN_SECRET);
            next();
        } catch (err) {
            return res.redirect('/admin-login.html');
        }
    }

    // === API Endpoints ===
    app.post('/admin/login', (req, res) => {
        const { username, password } = req.body;
        if (username === ADMIN_USER && password === ADMIN_PASS) {
            const adminToken = jwt.sign({ user: username, role: 'admin' }, ADMIN_TOKEN_SECRET, { expiresIn: '8h' });
            res.cookie('admin_token', adminToken, { httpOnly: true, path: '/' });
            res.status(200).json({ success: true });
        } else {
            res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu.' });
        }
    });
    
    app.post('/admin/logout', (req, res) => {
        res.clearCookie('admin_token', { path: '/' });
        res.status(200).json({ success: true });
    });

    // Route cho trang dashboard chính
    app.get('/admin', verifyAdminTokenMiddleware, (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
    });

    // === Các API được bảo vệ ===
    const apiRouter = express.Router();
    apiRouter.use(verifyAdminTokenMiddleware);

    apiRouter.get('/users', async (req, res) => {
        try {
            const keys = await redis.keys('username:*');
            const users = [];
            for (const key of keys) {
                const userId = await redis.get(key);
                if (userId) {
                    const userProfile = await redis.hgetall(`user:${userId}`);
                    delete userProfile.password;
                    users.push(userProfile);
                }
            }
            res.json(users);
        } catch (error) {
            console.error("Lỗi lấy danh sách user:", error);
            res.status(500).send('Lỗi server.');
        }
    });

    // API Endpoint để THÊM một người dùng mới
    apiRouter.post('/users', async (req, res) => {
        const { username, password } = req.body;

        if (!username || username.trim().length < 2 || !/^[a-zA-Z0-9_-]+$/.test(username.trim())) {
            return res.status(400).json({ success: false, message: 'Tên người dùng không hợp lệ.' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự.' });
        }

        try {
            const usernameKey = `username:${username.toLowerCase()}`;
            if (await redis.get(usernameKey)) {
                return res.status(409).json({ success: false, message: 'Tên người dùng đã tồn tại.' });
            }

            const userId = uuidv4();
            const hashedPassword = await bcrypt.hash(password, 10);

            await redis.hset(`user:${userId}`,
                'userId', userId,
                'username', username,
                'password', hashedPassword,
                'joinedAt', new Date().toISOString(),
                'avatar', `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
                'messageCount', 0,
                'status', 'offline'
            );
            await redis.set(usernameKey, userId);

            io.to('admins').emit('admin_users_updated');
            res.status(201).json({ success: true, message: `Đã tạo người dùng ${username}` });
        } catch (error) {
            console.error(`Lỗi tạo người dùng ${username}:`, error);
            res.status(500).send('Lỗi server khi tạo người dùng.');
        }
    });

    // API Endpoint để SỬA thông tin người dùng
    apiRouter.put('/users', async (req, res) => {
        const { userId, newUsername, newPassword } = req.body;

        if (!userId) return res.status(400).json({ success: false, message: 'Thiếu User ID.' });
        if (!newUsername || newUsername.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'Tên người dùng mới không hợp lệ.' });
        }

        try {
            const userProfile = await redis.hgetall(`user:${userId}`);
            if (!userProfile.username) {
                return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
            }

            const pipeline = redis.pipeline();

            // Xử lý thay đổi mật khẩu (nếu có)
            if (newPassword && newPassword.length >= 6) {
                const hashedPassword = await bcrypt.hash(newPassword, 10);
                pipeline.hset(`user:${userId}`, 'password', hashedPassword);
            }

            // Xử lý thay đổi username (nếu có)
            if (newUsername !== userProfile.username) {
                const newUsernameKey = `username:${newUsername.toLowerCase()}`;
                if (await redis.get(newUsernameKey)) {
                    return res.status(409).json({ success: false, message: 'Tên người dùng mới đã tồn tại.' });
                }
                // Xóa key username cũ và tạo key mới
                pipeline.del(`username:${userProfile.username.toLowerCase()}`);
                pipeline.set(newUsernameKey, userId);
                pipeline.hset(`user:${userId}`, 'username', newUsername);
            }

            await pipeline.exec();
            io.to('admins').emit('admin_users_updated');
            res.status(200).json({ success: true, message: 'Đã cập nhật thông tin người dùng.' });

        } catch (error) {
            console.error(`Lỗi sửa người dùng ${userId}:`, error);
            res.status(500).send('Lỗi server khi sửa người dùng.');
        }
    });

    apiRouter.get('/rooms', async (req, res) => {
        try {
            const rooms = await redis.smembers(ALL_ROOMS_KEY);
            res.json(rooms.sort());
        } catch (error) {
            console.error("Lỗi lấy danh sách phòng:", error);
            res.status(500).send('Lỗi server.');
        }
    });

    apiRouter.delete('/rooms', async (req, res) => {
        const { roomName } = req.body;
        if (!roomName) return res.status(400).send('Tên phòng là bắt buộc.');
        if (defaultRooms.includes(roomName)) return res.status(403).json({ success: false, message: 'Không thể xóa phòng mặc định.' });
        try {
            const pipeline = redis.pipeline();
            pipeline.srem(ALL_ROOMS_KEY, roomName);
            pipeline.del(`messages:${roomName}`, `order:${roomName}`, `pinned_message:${roomName}`);
            await pipeline.exec();
            const updatedRooms = await redis.smembers(ALL_ROOMS_KEY);
            pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));
            io.to('admins').emit('admin_rooms_updated');
            res.status(200).json({ success: true });
        } catch (error) {
            console.error(`Lỗi xóa phòng ${roomName}:`, error);
            res.status(500).send('Lỗi server.');
        }
    });

    // API Endpoint để XÓA một người dùng
    apiRouter.delete('/users', async (req, res) => {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ success: false, message: 'Thiếu User ID.' });
        }

        try {
            const userProfile = await redis.hgetall(`user:${userId}`);

            if (!userProfile.username) {
                return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
            }

            // >> KIỂM TRA ĐIỀU KIỆN: KHÔNG XÓA NẾU USER ĐANG ONLINE <<
            if (userProfile.status === 'online') {
                return res.status(403).json({ success: false, message: 'Không thể xóa người dùng đang online.' });
            }

            const pipeline = redis.pipeline();
            // 1. Xóa hash chính chứa thông tin người dùng
            pipeline.del(`user:${userId}`);
            // 2. Xóa key dùng để tra cứu username khi login
            pipeline.del(`username:${userProfile.username.toLowerCase()}`);
            // 3. Dọn dẹp tin nhắn chưa đọc (nếu có)
            pipeline.del(`unread_counts:${userId}`);
            
            await pipeline.exec();

            io.to('admins').emit('admin_users_updated');
            res.status(200).json({ success: true, message: 'Đã xóa người dùng thành công.' });

        } catch (error) {
            console.error(`Lỗi xóa người dùng ${userId}:`, error);
            res.status(500).send('Lỗi server khi xóa người dùng.');
        }
    });

    // API Endpoint để THÊM một phòng chat mới
    apiRouter.post('/rooms', async (req, res) => {
        const { roomName } = req.body;

        if (!roomName || roomName.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'Tên phòng không hợp lệ.' });
        }

        try {
            const roomExists = await redis.sismember(ALL_ROOMS_KEY, roomName);
            if (roomExists) {
                return res.status(409).json({ success: false, message: 'Tên phòng đã tồn tại.' });
            }

            await redis.sadd(ALL_ROOMS_KEY, roomName);

            const updatedRooms = await redis.smembers(ALL_ROOMS_KEY);
            pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));
            io.to('admins').emit('admin_rooms_updated');
            
            res.status(201).json({ success: true, message: `Đã tạo phòng ${roomName}` });
        } catch (error) {
            console.error(`Lỗi tạo phòng ${roomName}:`, error);
            res.status(500).send('Lỗi server khi tạo phòng.');
        }
    });

    // API Endpoint để SỬA tên một phòng chat
    apiRouter.put('/rooms', async (req, res) => {
        const { oldRoomName, newRoomName } = req.body;

        if (!oldRoomName || !newRoomName || newRoomName.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'Tên phòng cũ và mới không hợp lệ.' });
        }
        if (defaultRooms.includes(oldRoomName)) {
            return res.status(403).json({ success: false, message: 'Không thể sửa tên phòng mặc định.' });
        }

        try {
            const newRoomExists = await redis.sismember(ALL_ROOMS_KEY, newRoomName);
            if (newRoomExists) {
                return res.status(409).json({ success: false, message: 'Tên phòng mới đã tồn tại.' });
            }

            const pipeline = redis.pipeline();
            // 1. Xóa tên cũ, thêm tên mới
            pipeline.srem(ALL_ROOMS_KEY, oldRoomName);
            pipeline.sadd(ALL_ROOMS_KEY, newRoomName);
            // 2. Đổi tên các key chứa dữ liệu của phòng
            pipeline.rename(`messages:${oldRoomName}`, `messages:${newRoomName}`);
            pipeline.rename(`order:${oldRoomName}`, `order:${newRoomName}`);
            pipeline.rename(`pinned_message:${oldRoomName}`, `pinned_message:${newRoomName}`);
            await pipeline.exec();

            const updatedRooms = await redis.smembers(ALL_ROOMS_KEY);
            pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));
            io.to('admins').emit('admin_rooms_updated');

            res.status(200).json({ success: true, message: 'Đã cập nhật tên phòng.' });
        } catch (error) {
            console.error(`Lỗi sửa phòng ${oldRoomName}:`, error);
            res.status(500).send('Lỗi server khi sửa phòng.');
        }
    });

    // API Endpoint MỚI: Lấy lịch sử chat (cho cả phòng và chat riêng)
    apiRouter.get('/chat-history', async (req, res) => {
        const { type, roomName, user1, user2 } = req.query;
        const historyLimit = 100; 

        try {
            let chatId;
            // --- Trường hợp 1: Lấy lịch sử chat phòng ---
            if (type === 'room' && roomName) {
                chatId = roomName;
            } 
            // --- Trường hợp 2: Lấy lịch sử chat riêng ---
            else if (type === 'private' && user1 && user2) {
                const userId1 = await redis.get(`username:${user1.toLowerCase()}`);
                const userId2 = await redis.get(`username:${user2.toLowerCase()}`);

                if (!userId1 || !userId2) {
                    return res.status(404).json({ success: false, message: 'Một hoặc hai người dùng không tồn tại.' });
                }

                // Sắp xếp userId để tạo ra privateChatId một cách nhất quán
                const chatParticipants = [userId1, userId2].sort();
                const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
                chatId = privateChatId;
            } 
            else {
                return res.status(400).json({ success: false, message: 'Tham số không hợp lệ.' });
            }
            
            // --- Truy vấn Redis để lấy lịch sử ---
            const messageIds = await redis.zrange(`order:${chatId}`, -historyLimit, -1);
            
            if (!messageIds || messageIds.length === 0) {
                return res.json([]); 
            }
            
            const historyMessages = await redis.hmget(`messages:${chatId}`, ...messageIds);
            const formattedHistory = historyMessages
                .filter(msg => msg) 
                .map(msg => JSON.parse(msg)); 

            res.json(formattedHistory);

        } catch (error) {
            console.error("Lỗi lấy lịch sử chat:", error);
            res.status(500).send('Lỗi server khi lấy lịch sử chat.');
        }
    });


    // API Endpoint NÂNG CẤP: Lấy các số liệu thống kê cho Dashboard
    apiRouter.get('/stats', async (req, res) => {
        try {
            let totalUsers = await redis.get('stats:totalUsers');

            // TỰ CHỮA LỖI: Nếu bộ đếm không tồn tại, hãy tính toán lại
            if (!totalUsers) {
                const userKeys = await redis.keys('username:*');
                totalUsers = userKeys.length;
                // Lưu lại giá trị đúng vào Redis cho những lần gọi sau
                await redis.set('stats:totalUsers', totalUsers);
            }

            const [
                onlineUsersCount,
                totalRooms,
                totalMessages
            ] = await Promise.all([
                redis.scard(ALL_ONLINE_USERS_KEY),
                redis.scard(ALL_ROOMS_KEY),
                redis.get('stats:totalMessages')
            ]);

            res.json({
                onlineUsers: onlineUsersCount,
                totalUsers: parseInt(totalUsers) || 0,
                totalRooms: totalRooms,
                totalMessages: parseInt(totalMessages) || 0
            });

        } catch (error) {
            console.error("Lỗi lấy dữ liệu thống kê:", error);
            res.status(500).send('Lỗi server khi lấy thống kê.');
        }
    });

    // === CÁC API CHO SAO LƯU VÀ KHÔI PHỤC ===
    const backupDir = path.join(__dirname, '..', 'backups');

    // API để tạo một bản sao lưu thủ công
    apiRouter.post('/backup', async (req, res) => {
        try {
            await redis.bgsave();
            const redisDirResult = await redis.config('GET', 'dir');
            const redisDir = redisDirResult[1];
            const redisDumpFile = path.join(redisDir, 'dump.rdb');

            await new Promise(resolve => setTimeout(resolve, 5000));

            if (fs.existsSync(redisDumpFile)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupFileName = `backup-${timestamp}.rdb`;
                fs.copyFileSync(redisDumpFile, path.join(backupDir, backupFileName));
                res.status(200).json({ success: true, message: `Đã tạo thành công bản sao lưu: ${backupFileName}` });
            } else {
                throw new Error('Không tìm thấy file dump.rdb.');
            }
        } catch (error) {
            console.error('Lỗi tạo sao lưu thủ công:', error);
            res.status(500).json({ success: false, message: 'Lỗi server khi tạo sao lưu.' });
        }
    });

    // API để lấy danh sách các bản sao lưu
    apiRouter.get('/backups', (req, res) => {
        try {
            const files = fs.readdirSync(backupDir)
                .filter(file => file.endsWith('.rdb'))
                .map(file => {
                    const stats = fs.statSync(path.join(backupDir, file));
                    return {
                        name: file,
                        size: (stats.size / 1024).toFixed(2) + ' KB',
                        createdAt: stats.birthtime
                    };
                })
                .sort((a, b) => b.createdAt - a.createdAt);
            res.json(files);
        } catch (error) {
            console.error('Lỗi lấy danh sách sao lưu:', error);
            res.status(500).json([]);
        }
    });

    // API để xóa một bản sao lưu
    apiRouter.delete('/backups/:filename', (req, res) => {
        const { filename } = req.params;
        if (!filename || filename.includes('..') || !filename.endsWith('.rdb')) {
            return res.status(400).json({ success: false, message: 'Tên file không hợp lệ.' });
        }
        try {
            const filePath = path.join(backupDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                res.status(200).json({ success: true, message: 'Đã xóa bản sao lưu.' });
            } else {
                res.status(404).json({ success: false, message: 'Không tìm thấy file sao lưu.' });
            }
        } catch (error) {
            console.error(`Lỗi xóa file ${filename}:`, error);
            res.status(500).json({ success: false, message: 'Lỗi server khi xóa file.' });
        }
    });

    // API để khôi phục từ một bản sao lưu (PHIÊN BẢN SỬA LỖI HOÀN CHỈNH)
    apiRouter.post('/restore', async (req, res) => {
        const { filename } = req.body;
        if (!filename || !filename.endsWith('.rdb')) {
            return res.status(400).json({ success: false, message: 'Tên file không hợp lệ.' });
        }

        const backupFilePath = path.join(backupDir, filename);
        if (!fs.existsSync(backupFilePath)) {
            return res.status(404).json({ success: false, message: 'File sao lưu không tồn tại.' });
        }

        try {
            console.log(`Bắt đầu quá trình khôi phục từ file: ${filename}`);

            const redisDirResult = await redis.config('GET', 'dir');
            const redisDir = redisDirResult[1];
            const redisDumpFile = path.join(redisDir, 'dump.rdb');

            res.status(200).json({
                success: true,
                message: `File đã được khôi phục. Server sẽ tự tắt sau 2 giây. VUI LÒNG: 1. Khởi động lại server REDIS. 2. Khởi động lại server Node.js này.`
            });

            await redis.quit();
            console.log('Đã ngắt kết nối khỏi Redis.');

            fs.copyFileSync(backupFilePath, redisDumpFile);
            console.log(`Đã sao chép file sao lưu vào thư mục Redis.`);

            setTimeout(() => {
                console.log('✅ Khôi phục thành công. Đang tắt server Node.js để hoàn tất quá trình.');
                process.exit(0);
            }, 2000);

        } catch (error) {
            console.error('Lỗi khôi phục:', error);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Lỗi nghiêm trọng khi khôi phục. Vui lòng kiểm tra server.' });
            }
        }
    });

    app.use('/api/admin', apiRouter);
}

module.exports = adminRoutes;