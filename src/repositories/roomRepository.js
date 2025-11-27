const { redis } = require('../config/redis');
const { ALL_ROOMS_KEY } = require('../config/constants');

async function getAllRooms() {
    return await redis.smembers(ALL_ROOMS_KEY);
}

async function addRoom(roomName) {
    await redis.sadd(ALL_ROOMS_KEY, roomName);
}

async function removeRoom(roomName) {
    await redis.srem(ALL_ROOMS_KEY, roomName);
}

async function checkRoomExists(roomName) {
    return await redis.sismember(ALL_ROOMS_KEY, roomName);
}

module.exports = {
    getAllRooms,
    addRoom,
    removeRoom,
    checkRoomExists
};
