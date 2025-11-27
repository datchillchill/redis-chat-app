const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { redis } = require('../config/redis');

const backupDir = path.join(__dirname, '../../backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
}

async function createBackup() {
    await redis.bgsave();
    const redisDirResult = await redis.config('GET', 'dir');
    const redisDir = redisDirResult[1];
    const redisDumpFile = path.join(redisDir, 'dump.rdb');

    await new Promise(resolve => setTimeout(resolve, 5000));

    if (fs.existsSync(redisDumpFile)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `backup-${timestamp}.rdb`;
        const backupFilePath = path.join(backupDir, backupFileName);

        fs.copyFileSync(redisDumpFile, backupFilePath);
        return backupFileName;
    } else {
        throw new Error('Không tìm thấy file dump.rdb.');
    }
}

function listBackups() {
    return fs.readdirSync(backupDir)
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
}

function deleteBackup(filename) {
    const filePath = path.join(backupDir, filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

async function restoreBackup(filename) {
    const backupFilePath = path.join(backupDir, filename);
    if (!fs.existsSync(backupFilePath)) {
        throw new Error('File sao lưu không tồn tại.');
    }

    const redisDirResult = await redis.config('GET', 'dir');
    const redisDir = redisDirResult[1];
    const redisDumpFile = path.join(redisDir, 'dump.rdb');

    // Shutdown Redis without saving current state
    try {
        await redis.shutdown('NOSAVE');
    } catch (err) {
        // Redis connection will be closed after shutdown, this error is expected
        console.log('Redis đã được tắt để chuẩn bị khôi phục.');
    }

    // Wait a bit for Redis to fully shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Copy backup file to Redis directory
    fs.copyFileSync(backupFilePath, redisDumpFile);

    console.log(`Đã copy file backup vào ${redisDumpFile}`);
    console.log('VUI LÒNG KHỞI ĐỘNG LẠI REDIS SERVER để hoàn tất quá trình khôi phục!');

    // Note: Caller needs to handle process exit or restart
}

function scheduleAutoBackup() {
    cron.schedule('0 */6 * * *', async () => {
        try {
            console.log('Bắt đầu quá trình sao lưu tự động...');
            const backupName = await createBackup();
            console.log(`Sao lưu tự động thành công: ${backupName}`);
        } catch (error) {
            console.error('Lỗi trong quá trình sao lưu tự động:', error);
        }
    });
}

module.exports = {
    createBackup,
    listBackups,
    deleteBackup,
    restoreBackup,
    scheduleAutoBackup
};
