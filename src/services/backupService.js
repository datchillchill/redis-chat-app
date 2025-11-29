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

    let redisDir;
    let redisDumpFile;

    // Try to get Redis directory from running instance
    try {
        const redisDirResult = await redis.config('GET', 'dir');
        redisDir = redisDirResult[1];
        redisDumpFile = path.join(redisDir, 'dump.rdb');
        console.log(`Đã xác định thư mục Redis: ${redisDir}`);
    } catch (err) {
        // If Redis is not running, use default path
        console.log('Redis không chạy, sử dụng đường dẫn mặc định...');

        // Common Redis paths on Windows
        const possiblePaths = [
            'D:\\hufi\\hk7_1\\nosql\\CNTT\\Redis',
            'C:\\Program Files\\Redis',
            process.env.REDIS_DIR || ''
        ];

        for (const possiblePath of possiblePaths) {
            if (possiblePath && fs.existsSync(possiblePath)) {
                redisDir = possiblePath;
                redisDumpFile = path.join(redisDir, 'dump.rdb');
                console.log(`Tìm thấy thư mục Redis tại: ${redisDir}`);
                break;
            }
        }

        if (!redisDir) {
            throw new Error('Không tìm thấy thư mục Redis. Vui lòng đảm bảo Redis đã được cài đặt.');
        }
    }

    console.log('\n=== BẮT ĐẦU QUÁ TRÌNH KHÔI PHỤC ===\n');

    // Try to shutdown Redis if it's running
    try {
        console.log('Bước 1: Đang tắt Redis server...');
        await redis.shutdown('NOSAVE');
        console.log('Lệnh tắt Redis đã được gửi.');

        // Wait for Redis to shut down
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify Redis is down
        let isDown = false;
        for (let i = 0; i < 3; i++) {
            try {
                await redis.ping();
                console.log('Redis vẫn đang chạy, đợi thêm...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                if (err.message.includes('ECONNREFUSED') || err.message.includes('Connection is closed')) {
                    console.log('Redis đã tắt thành công.');
                    isDown = true;
                    break;
                }
            }
        }

        if (!isDown) {
            console.log('CẢNH BÁO: Không thể xác nhận Redis đã tắt.');
        }
    } catch (err) {
        console.log('Redis có thể đã tắt hoặc không chạy:', err.message);
    }

    console.log('\nBước 2: Đang sao chép file backup...');

    try {
        // Backup old dump.rdb if exists
        if (fs.existsSync(redisDumpFile)) {
            const oldBackup = redisDumpFile + '.old';
            fs.copyFileSync(redisDumpFile, oldBackup);
            console.log(`Đã sao lưu file cũ thành: ${oldBackup}`);
            fs.unlinkSync(redisDumpFile);
        }

        // Copy backup file to Redis directory
        fs.copyFileSync(backupFilePath, redisDumpFile);
        console.log(`Đã khôi phục file backup vào: ${redisDumpFile}`);

        console.log('\n=== KHÔI PHỤC HOÀN TẤT ===\n');
        console.log('HƯỚNG DẪN TIẾP THEO:');
        console.log('1. Mở terminal mới');
        console.log('2. Chạy lệnh: redis-server');
        console.log('3. Đợi Redis khởi động xong');
        console.log('4. Quay lại đây và chạy: npm run dev');
        console.log('\nServer sẽ tự động tắt sau 3 giây...\n');

    } catch (err) {
        console.error('\nLỖI KHI KHÔI PHỤC:', err.message);
        console.error('\nVui lòng thử các bước sau:');
        console.error('1. Đảm bảo Redis đã tắt hoàn toàn');
        console.error('2. Kiểm tra quyền truy cập thư mục Redis');
        console.error(`3. Thư mục Redis: ${redisDir}`);
        throw new Error('Không thể khôi phục dữ liệu. Xem log phía trên để biết chi tiết.');
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
