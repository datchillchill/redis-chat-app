const { redis } = require('../config/redis');

async function findUserIdByUsername(username) {
    return await redis.get(`username:${username.toLowerCase()}`);
}

async function findUserById(userId) {
    return await redis.hgetall(`user:${userId}`);
}

async function createUser(userId, username, hashedPassword, socketId) {
    const USER_HASH_KEY = `user:${userId}`;
    const USERNAME_INDEX_KEY = `username:${username.toLowerCase()}`;

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
    await redis.set(USERNAME_INDEX_KEY, userId);
}

async function updateUserStatus(userId, socketId, status) {
    await redis.hset(`user:${userId}`, 'socketId', socketId, 'status', status);
}

async function incrementMessageCount(userId) {
    await redis.hincrby(`user:${userId}`, 'messageCount', 1);
}

async function getOnlineUserIds(key) {
    return await redis.smembers(key);
}

async function addOnlineUser(key, userId) {
    await redis.sadd(key, userId);
}

async function removeOnlineUser(key, userId) {
    await redis.srem(key, userId);
}

module.exports = {
    findUserIdByUsername,
    findUserById,
    createUser,
    updateUserStatus,
    incrementMessageCount,
    getOnlineUserIds,
    addOnlineUser,
    removeOnlineUser
};
