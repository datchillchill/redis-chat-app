require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

module.exports = {
    JWT_SECRET,
    ADMIN_TOKEN_SECRET: JWT_SECRET + '-admin',
    ALL_ROOMS_KEY: 'app:rooms',
    ALL_ONLINE_USERS_KEY: 'app:onlineUsers',
    DEFAULT_ROOMS: [],
    USER_PRESENCE_TTL: 15,
    MESSAGE_HISTORY_LIMIT: 100,
    PRIVATE_CHAT_HISTORY_LIMIT: 50,
    PRIVATE_CHAT_TTL: 7 * 24 * 60 * 60,
    RATE_LIMIT_MESSAGES: 10,
    MESSAGE_RETENTION_SECONDS: 60 * 60 * 24 * 7,
    RATE_LIMIT_WINDOW: 60
};
