const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const userRepo = require('../repositories/userRepository');
const { generateToken } = require('../utils/helpers');

async function register(username, password, socketId) {
    const existingId = await userRepo.findUserIdByUsername(username);
    if (existingId) return { error: 'Tên người dùng đã tồn tại' };

    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    await userRepo.createUser(userId, username, hashedPassword, socketId);

    const token = generateToken(userId, username);
    return { userId, token };
}

async function login(username, password) {
    const userId = await userRepo.findUserIdByUsername(username);
    if (!userId) return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };

    const userProfile = await userRepo.findUserById(userId);
    if (!userProfile || !userProfile.password) return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };

    const passwordMatch = await bcrypt.compare(password, userProfile.password);
    if (!passwordMatch) return { error: 'Tên đăng nhập hoặc mật khẩu không đúng' };

    const token = generateToken(userId, userProfile.username);
    return { userId, token, username: userProfile.username, success: true };
}

module.exports = {
    register,
    login
};
