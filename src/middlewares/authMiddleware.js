const jwt = require('jsonwebtoken');
const { ADMIN_TOKEN_SECRET } = require('../config/constants');

function verifyAdminToken(req, res, next) {
    const token = req.cookies.admin_token;
    if (!token) {
        return res.redirect('/admin/login');
    }
    try {
        jwt.verify(token, ADMIN_TOKEN_SECRET);
        next();
    } catch (err) {
        return res.redirect('/admin/login');
    }
}

function verifyApiToken(req, res, next) {
    const bearerHeader = req.headers['authorization'];
    if (typeof bearerHeader !== 'undefined') {
        const bearer = bearerHeader.split(' ');
        const bearerToken = bearer[1];
        jwt.verify(bearerToken, process.env.JWT_SECRET || 'your-secret-key-change-in-production', (err, authData) => {
            if (err) {
                res.sendStatus(403);
            } else {
                req.authData = authData;
                next();
            }
        });
    } else {
        res.sendStatus(403);
    }
}

module.exports = { verifyAdminToken, verifyApiToken };
