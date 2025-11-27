require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');

// Config & Utils
const { redis, pubClient } = require('./src/config/redis');
const { DEFAULT_ROOMS } = require('./src/config/constants');

// Routes
const adminRoutes = require('./src/routes/adminRoutes');
const apiRoutes = require('./src/routes/apiRoutes');
const uploadRoutes = require('./src/routes/uploadRoutes');

// Sockets
const chatSocket = require('./src/sockets/chatSocket');
const socketAuthMiddleware = require('./src/sockets/middleware');

// Repositories & Services
const roomRepo = require('./src/repositories/roomRepository');
const backupService = require('./src/services/backupService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Make io available in routes
app.set('io', io);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure uploads directory exists
const uploadDir = 'public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin Routes
app.use('/admin', adminRoutes);
app.use('/api/admin', apiRoutes);
app.use('/upload', uploadRoutes);

// Socket.IO
io.use(socketAuthMiddleware);
chatSocket.initializeChat(io);

// Initialize Default Rooms
(async () => {
  try {
    for (const room of DEFAULT_ROOMS) {
      await roomRepo.addRoom(room);
    }
    console.log('✅ Default rooms initialized');
  } catch (err) {
    console.error('❌ Error initializing rooms:', err);
  }
})();

// Start Backup Service Scheduler
backupService.scheduleAutoBackup();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});