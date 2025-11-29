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

    console.log('Đang tắt Redis server...');
    // Shutdown Redis without saving current state
    try {
        await redis.shutdown('NOSAVE');
    } catch (err) {
        // Redis connection will be closed, or if it's already closed, that's fine.
        console.log('Lệnh tắt Redis đã được gửi.');
    }

    // Wait and verify Redis is actually down
    console.log('Đang đợi Redis tắt hẳn...');
    let retries = 5;
    while (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            // Try to ping. If it succeeds, Redis is still up.
            // We need a NEW connection because the old one might be in a weird state or auto-reconnecting.
            // But 'redis' object handles reconnection. If we can ping, it's up.
            // If we can't ping (connection refused), it's down.
            await redis.ping();
            console.log('Redis vẫn đang chạy, đợi thêm...');
            retries--;
        } catch (err) {
            if (err.message.includes('ECONNREFUSED') || err.message.includes('Closed')) {
                console.log('Đã xác nhận Redis đã tắt.');
                break;
            }
            console.log('Lỗi khi kiểm tra trạng thái Redis (có thể đã tắt):', err.message);
            break; // Assume down if other errors
        }
    }

    if (retries === 0) {
        throw new Error('Không thể tắt Redis server. Vui lòng tắt thủ công và thử lại.');
    }

    // Safety delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        if (fs.existsSync(redisDumpFile)) {
            fs.unlinkSync(redisDumpFile); // Delete old dump to prevent issues
        }
        fs.copyFileSync(backupFilePath, redisDumpFile);
        console.log(`Đã khôi phục file backup vào ${redisDumpFile}`);
        console.log('VUI LÒNG KHỞI ĐỘNG LẠI REDIS SERVER NGAY BÂY GIỜ!');
    } catch (err) {
        console.error('Lỗi khi copy file backup:', err);
        throw new Error('Lỗi khi ghi đè file database. Hãy kiểm tra quyền truy cập.');
    }
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
