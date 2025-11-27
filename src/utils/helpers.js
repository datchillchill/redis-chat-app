const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/constants');

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

module.exports = {
    generateToken,
    verifyToken,
    validateUsername,
    validatePassword,
    validateRoomName,
    validateMessage,
    sanitizeMessage,
    getMessageContentPreview
};
