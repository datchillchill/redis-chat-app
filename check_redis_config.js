const Redis = require('ioredis');
const redis = new Redis();

async function checkConfig() {
    try {
        const appendOnly = await redis.config('GET', 'appendonly');
        const dbFilename = await redis.config('GET', 'dbfilename');
        const dir = await redis.config('GET', 'dir');

        console.log('Redis Configuration:');
        console.log(`appendonly: ${appendOnly[1]}`);
        console.log(`dbfilename: ${dbFilename[1]}`);
        console.log(`dir: ${dir[1]}`);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        redis.disconnect();
    }
}

checkConfig();
