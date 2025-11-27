const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { ADMIN_TOKEN_SECRET, DEFAULT_ROOMS, ALL_ROOMS_KEY, ALL_ONLINE_USERS_KEY } = require('../config/constants');
const userRepo = require('../repositories/userRepository');
const roomRepo = require('../repositories/roomRepository');
const messageRepo = require('../repositories/messageRepository');
const backupService = require('../services/backupService');
const { redis, pubClient } = require('../config/redis');

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

exports.login = (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const adminToken = jwt.sign({ user: username, role: 'admin' }, ADMIN_TOKEN_SECRET, { expiresIn: '8h' });
        res.cookie('admin_token', adminToken, { httpOnly: true, path: '/' });
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu.' });
    }
};

exports.logout = (req, res) => {
    res.clearCookie('admin_token', { path: '/' });
    res.status(200).json({ success: true });
};

exports.getDashboard = (req, res) => {
    res.render('admin/admin'); // Assuming view engine setup
};

exports.getUsers = async (req, res) => {
    try {
        const keys = await redis.keys('username:*');
        const users = [];
        for (const key of keys) {
            const userId = await redis.get(key);
            if (userId) {
                const userProfile = await userRepo.findUserById(userId);
                delete userProfile.password;
                users.push(userProfile);
            }
        }
        res.json(users);
    } catch (error) {
        console.error("Lỗi lấy danh sách user:", error);
        res.status(500).send('Lỗi server.');
    }
};

exports.addUser = async (req, res) => {
    const { username, password } = req.body;
    if (!username || username.trim().length < 2 || !/^[a-zA-Z0-9_-]+$/.test(username.trim())) {
        return res.status(400).json({ success: false, message: 'Tên người dùng không hợp lệ.' });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }

    try {
        const existingId = await userRepo.findUserIdByUsername(username);
        if (existingId) {
            return res.status(409).json({ success: false, message: 'Tên người dùng đã tồn tại.' });
        }

        const userId = uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);
        await userRepo.createUser(userId, username, hashedPassword, null);

        const io = req.app.get('io');
        io.to('admins').emit('admin_users_updated');
        res.status(201).json({ success: true, message: `Đã tạo người dùng ${username}` });
    } catch (error) {
        console.error(`Lỗi tạo người dùng ${username}:`, error);
        res.status(500).send('Lỗi server khi tạo người dùng.');
    }
};

exports.updateUser = async (req, res) => {
    const { userId, newUsername, newPassword } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Thiếu User ID.' });
    if (!newUsername || newUsername.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Tên người dùng mới không hợp lệ.' });
    }

    try {
        const userProfile = await userRepo.findUserById(userId);
        if (!userProfile.username) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
        }

        const pipeline = redis.pipeline();
        if (newPassword && newPassword.length >= 6) {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            pipeline.hset(`user:${userId}`, 'password', hashedPassword);
        }

        if (newUsername !== userProfile.username) {
            const existingId = await userRepo.findUserIdByUsername(newUsername);
            if (existingId) {
                return res.status(409).json({ success: false, message: 'Tên người dùng mới đã tồn tại.' });
            }
            pipeline.del(`username:${userProfile.username.toLowerCase()}`);
            pipeline.set(`username:${newUsername.toLowerCase()}`, userId);
            pipeline.hset(`user:${userId}`, 'username', newUsername);
        }

        await pipeline.exec();
        const io = req.app.get('io');
        io.to('admins').emit('admin_users_updated');
        res.status(200).json({ success: true, message: 'Đã cập nhật thông tin người dùng.' });
    } catch (error) {
        console.error(`Lỗi sửa người dùng ${userId}:`, error);
        res.status(500).send('Lỗi server khi sửa người dùng.');
    }
};

exports.deleteUser = async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Thiếu User ID.' });

    try {
        const userProfile = await userRepo.findUserById(userId);
        if (!userProfile.username) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
        }
        if (userProfile.status === 'online') {
            return res.status(403).json({ success: false, message: 'Không thể xóa người dùng đang online.' });
        }

        const pipeline = redis.pipeline();
        pipeline.del(`user:${userId}`);
        pipeline.del(`username:${userProfile.username.toLowerCase()}`);
        pipeline.del(`unread_counts:${userId}`);
        await pipeline.exec();

        const io = req.app.get('io');
        io.to('admins').emit('admin_users_updated');
        res.status(200).json({ success: true, message: 'Đã xóa người dùng thành công.' });
    } catch (error) {
        console.error(`Lỗi xóa người dùng ${userId}:`, error);
        res.status(500).send('Lỗi server khi xóa người dùng.');
    }
};

exports.getRooms = async (req, res) => {
    try {
        const rooms = await roomRepo.getAllRooms();
        res.json(rooms.sort());
    } catch (error) {
        console.error("Lỗi lấy danh sách phòng:", error);
        res.status(500).send('Lỗi server.');
    }
};

exports.addRoom = async (req, res) => {
    const { roomName } = req.body;
    if (!roomName || roomName.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Tên phòng không hợp lệ.' });
    }

    try {
        if (await roomRepo.checkRoomExists(roomName)) {
            return res.status(409).json({ success: false, message: 'Tên phòng đã tồn tại.' });
        }

        await roomRepo.addRoom(roomName);
        const updatedRooms = await roomRepo.getAllRooms();
        pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));

        const io = req.app.get('io');
        io.to('admins').emit('admin_rooms_updated');
        res.status(201).json({ success: true, message: `Đã tạo phòng ${roomName}` });
    } catch (error) {
        console.error(`Lỗi tạo phòng ${roomName}:`, error);
        res.status(500).send('Lỗi server khi tạo phòng.');
    }
};

exports.updateRoom = async (req, res) => {
    const { oldRoomName, newRoomName } = req.body;
    if (!oldRoomName || !newRoomName || newRoomName.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Tên phòng cũ và mới không hợp lệ.' });
    }
    if (DEFAULT_ROOMS.includes(oldRoomName)) {
        return res.status(403).json({ success: false, message: 'Không thể sửa tên phòng mặc định.' });
    }

    try {
        if (await roomRepo.checkRoomExists(newRoomName)) {
            return res.status(409).json({ success: false, message: 'Tên phòng mới đã tồn tại.' });
        }

        const pipeline = redis.pipeline();
        pipeline.srem(ALL_ROOMS_KEY, oldRoomName);
        pipeline.sadd(ALL_ROOMS_KEY, newRoomName);
        pipeline.rename(`messages:${oldRoomName}`, `messages:${newRoomName}`);
        pipeline.rename(`order:${oldRoomName}`, `order:${newRoomName}`);
        pipeline.rename(`pinned_message:${oldRoomName}`, `pinned_message:${newRoomName}`);
        await pipeline.exec();

        const updatedRooms = await roomRepo.getAllRooms();
        pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));

        const io = req.app.get('io');
        io.to('admins').emit('admin_rooms_updated');
        res.status(200).json({ success: true, message: 'Đã cập nhật tên phòng.' });
    } catch (error) {
        console.error(`Lỗi sửa phòng ${oldRoomName}:`, error);
        res.status(500).send('Lỗi server khi sửa phòng.');
    }
};

exports.deleteRoom = async (req, res) => {
    const { roomName } = req.body;
    if (!roomName) return res.status(400).send('Tên phòng là bắt buộc.');
    if (DEFAULT_ROOMS.includes(roomName)) return res.status(403).json({ success: false, message: 'Không thể xóa phòng mặc định.' });

    try {
        const pipeline = redis.pipeline();
        pipeline.srem(ALL_ROOMS_KEY, roomName);
        pipeline.del(`messages:${roomName}`, `order:${roomName}`, `pinned_message:${roomName}`);
        await pipeline.exec();

        const updatedRooms = await roomRepo.getAllRooms();
        pubClient.publish(`app:rooms:list_update`, JSON.stringify(updatedRooms));

        const io = req.app.get('io');
        io.to('admins').emit('admin_rooms_updated');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error(`Lỗi xóa phòng ${roomName}:`, error);
        res.status(500).send('Lỗi server.');
    }
};

exports.getChatHistory = async (req, res) => {
    const { type, roomName, user1, user2 } = req.query;
    const historyLimit = 100;

    try {
        let chatId;
        if (type === 'room' && roomName) {
            chatId = roomName;
        } else if (type === 'private' && user1 && user2) {
            const userId1 = await userRepo.findUserIdByUsername(user1);
            const userId2 = await userRepo.findUserIdByUsername(user2);
            if (!userId1 || !userId2) {
                return res.status(404).json({ success: false, message: 'Một hoặc hai người dùng không tồn tại.' });
            }
            const chatParticipants = [userId1, userId2].sort();
            chatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
        } else {
            return res.status(400).json({ success: false, message: 'Tham số không hợp lệ.' });
        }

        const history = await messageRepo.getHistory(chatId, historyLimit);
        res.json(history);
    } catch (error) {
        console.error("Lỗi lấy lịch sử chat:", error);
        res.status(500).send('Lỗi server khi lấy lịch sử chat.');
    }
};

exports.getStats = async (req, res) => {
    try {
        const userKeys = await redis.keys('username:*');
        const totalUsers = userKeys.length;
        const onlineUsersCount = await redis.scard(ALL_ONLINE_USERS_KEY);
        const totalRooms = await redis.scard(ALL_ROOMS_KEY);
        const totalMessages = await redis.get('stats:totalMessages');

        res.json({
            onlineUsers: onlineUsersCount,
            totalUsers: totalUsers,
            totalRooms: totalRooms,
            totalMessages: parseInt(totalMessages) || 0
        });
    } catch (error) {
        console.error("Lỗi lấy dữ liệu thống kê:", error);
        res.status(500).send('Lỗi server khi lấy thống kê.');
    }
};

exports.createBackup = async (req, res) => {
    try {
        const backupFileName = await backupService.createBackup();
        res.status(200).json({ success: true, message: `Đã tạo thành công bản sao lưu: ${backupFileName}` });
    } catch (error) {
        console.error('Lỗi tạo sao lưu thủ công:', error);
        res.status(500).json({ success: false, message: 'Lỗi server khi tạo sao lưu.' });
    }
};

exports.getBackups = (req, res) => {
    try {
        const files = backupService.listBackups();
        res.json(files);
    } catch (error) {
        console.error('Lỗi lấy danh sách sao lưu:', error);
        res.status(500).json([]);
    }
};

exports.deleteBackup = (req, res) => {
    const { filename } = req.params;
    if (!filename || filename.includes('..') || !filename.endsWith('.rdb')) {
        return res.status(400).json({ success: false, message: 'Tên file không hợp lệ.' });
    }
    try {
        if (backupService.deleteBackup(filename)) {
            res.status(200).json({ success: true, message: 'Đã xóa bản sao lưu.' });
        } else {
            res.status(404).json({ success: false, message: 'Không tìm thấy file sao lưu.' });
        }
    } catch (error) {
        console.error(`Lỗi xóa file ${filename}:`, error);
        res.status(500).json({ success: false, message: 'Lỗi server khi xóa file.' });
    }
};

exports.restoreBackup = async (req, res) => {
    const { filename } = req.body;
    if (!filename || !filename.endsWith('.rdb')) {
        return res.status(400).json({ success: false, message: 'Tên file không hợp lệ.' });
    }

    try {
        console.log(`Bắt đầu quá trình khôi phục từ file: ${filename}`);

        res.status(200).json({
            success: true,
            message: `Đang khôi phục dữ liệu...\n\nQUAN TRỌNG:\n1. Redis server sẽ tự động tắt\n2. Sau khi Node.js server tắt, hãy KHỞI ĐỘNG LẠI REDIS SERVER\n3. Sau đó khởi động lại ứng dụng này\n\nServer sẽ tắt sau 3 giây...`
        });

        await backupService.restoreBackup(filename);

        setTimeout(() => {
            console.log('Khôi phục hoàn tất. Đang tắt Node.js server...');
            console.log('TIẾP THEO: Khởi động lại Redis server, sau đó khởi động lại ứng dụng này.');
            process.exit(0);
        }, 3000);

    } catch (error) {
        console.error('Lỗi khôi phục:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Lỗi nghiêm trọng khi khôi phục. Vui lòng kiểm tra server.' });
        }
    }
};
