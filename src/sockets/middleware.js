const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { ADMIN_TOKEN_SECRET } = require('../config/constants');

function socketAuthMiddleware(socket, next) {
    const parser = cookieParser();
    parser(socket.request, {}, () => {
        const token = socket.request.cookies.admin_token;
        if (token) {
            try {
                jwt.verify(token, ADMIN_TOKEN_SECRET);
                socket.isAdmin = true;
            } catch (err) {
            }
        }
        next();
    });
}

module.exports = socketAuthMiddleware;
