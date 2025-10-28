// routes/admin.js

const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const cookieParser = require('cookie-parser');

function adminRoutes(app, redis, JWT_SECRET, defaultRooms, ALL_ROOMS_KEY, io, pubClient) {
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

    app.use('/api/admin', apiRouter);
}

module.exports = adminRoutes;