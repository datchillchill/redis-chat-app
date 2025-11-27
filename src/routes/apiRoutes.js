const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { verifyAdminToken } = require('../middlewares/authMiddleware');

router.use(verifyAdminToken);

router.get('/users', adminController.getUsers);
router.post('/users', adminController.addUser);
router.put('/users', adminController.updateUser);
router.delete('/users', adminController.deleteUser);

router.get('/rooms', adminController.getRooms);
router.post('/rooms', adminController.addRoom);
router.put('/rooms', adminController.updateRoom);
router.delete('/rooms', adminController.deleteRoom);

router.get('/chat-history', adminController.getChatHistory);
router.get('/stats', adminController.getStats);

router.post('/backup', adminController.createBackup);
router.get('/backups', adminController.getBackups);
router.delete('/backups/:filename', adminController.deleteBackup);
router.post('/restore', adminController.restoreBackup);

module.exports = router;
