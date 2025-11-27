const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { verifyAdminToken } = require('../middlewares/authMiddleware');

router.get('/login', (req, res) => {
    if (req.cookies.admin_token) {
        return res.redirect('/admin');
    }
    res.render('admin/login');
});

router.post('/login', adminController.login);
router.post('/logout', adminController.logout);
router.get('/', verifyAdminToken, adminController.getDashboard);

module.exports = router;
