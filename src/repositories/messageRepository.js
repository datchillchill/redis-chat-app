const { redis } = require('../config/redis');
const { MESSAGE_RETENTION_SECONDS } = require('../config/constants');

async function saveMessage(roomId, messageId, messageObject, timestamp, ttl = MESSAGE_RETENTION_SECONDS) {
    const MESSAGES_HASH_KEY = `messages:${roomId}`;
    const ORDER_ZSET_KEY = `order:${roomId}`;
    const messageString = JSON.stringify(messageObject);

    const pipeline = redis.pipeline();
    pipeline.hset(MESSAGES_HASH_KEY, messageId, messageString);
    pipeline.zadd(ORDER_ZSET_KEY, timestamp, messageId);
    pipeline.expire(MESSAGES_HASH_KEY, ttl);
    pipeline.expire(ORDER_ZSET_KEY, ttl);

    if (messageObject.replyTo && messageObject.replyTo.messageId) {
        pipeline.sadd(`replies_to:${messageObject.replyTo.messageId}`, messageId)
            .expire(`replies_to:${messageObject.replyTo.messageId}`, ttl);
    }

    await pipeline.exec();
}

async function getMessage(roomId, messageId) {
    const msg = await redis.hget(`messages:${roomId}`, messageId);
    return msg ? JSON.parse(msg) : null;
}

async function updateMessage(roomId, messageId, messageObject) {
    await redis.hset(`messages:${roomId}`, messageId, JSON.stringify(messageObject));
}

async function deleteMessage(roomId, messageId) {
    const MESSAGES_HASH_KEY = `messages:${roomId}`;
    const ORDER_ZSET_KEY = `order:${roomId}`;

    const pipeline = redis.pipeline();
    pipeline.hdel(MESSAGES_HASH_KEY, messageId);
    pipeline.zrem(ORDER_ZSET_KEY, messageId);
    pipeline.del(`replies_to:${messageId}`);
    await pipeline.exec();
}

async function getHistory(roomId, limit) {
    const messageIds = await redis.zrange(`order:${roomId}`, -limit, -1);
    if (!messageIds || messageIds.length === 0) return [];

    const historyMessages = await redis.hmget(`messages:${roomId}`, ...messageIds);
    return historyMessages.filter(msg => msg).map(msg => JSON.parse(msg));
}

async function getPinnedMessageId(roomId) {
    return await redis.get(`pinned_message:${roomId}`);
}

async function setPinnedMessageId(roomId, messageId) {
    await redis.set(`pinned_message:${roomId}`, messageId);
}

async function removePinnedMessageId(roomId) {
    await redis.del(`pinned_message:${roomId}`);
}

async function getReplies(messageId) {
    return await redis.smembers(`replies_to:${messageId}`);
}

module.exports = {
    saveMessage,
    getMessage,
    updateMessage,
    deleteMessage,
    getHistory,
    getPinnedMessageId,
    setPinnedMessageId,
    removePinnedMessageId,
    getReplies
};
