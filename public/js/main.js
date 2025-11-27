const socket = io();
let currentMode = 'login';
let authToken = localStorage.getItem('chatToken');
let currentUsername = localStorage.getItem('chatUsername');
let currentUserId = localStorage.getItem('chatUserId');

const authContainer = document.getElementById('authContainer');
const chatContainer = document.getElementById('chatContainer');
const authTitle = document.getElementById('authTitle');
const authError = document.getElementById('authError');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const submitBtn = document.getElementById('submitBtn');
const toggleBtn = document.getElementById('toggleBtn');
const toggleText = document.getElementById('toggleText');
const toggleLink = document.getElementById('toggleLink');
const logoutBtn = document.getElementById('logoutBtn');
const currentUsernameSpan = document.getElementById('currentUsername');
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const roomListDiv = document.getElementById('room-list');
const newRoomNameInput = document.getElementById('newRoomNameInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const userListUl = document.getElementById('user-list');
const userCountSpan = document.getElementById('user-count');
const chatHeaderTitle = document.getElementById('chatHeaderTitle');
const searchBtn = document.getElementById('searchBtn');
const searchContainer = document.getElementById('searchContainer');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const prevResultBtn = document.getElementById('prevResultBtn');
const nextResultBtn = document.getElementById('nextResultBtn');
const closeSearchBtn = document.getElementById('closeSearchBtn');
const typingIndicator = document.getElementById('typingIndicator');
const pinnedMessageBar = document.getElementById('pinnedMessageBar');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const messagesOnScreen = new Map();
const notificationSound = document.getElementById('notificationSound');

let typingTimeout;
let typingUsers = {};
let currentReplyInfo = null;
let currentPinnedMessageId = null;
let fullHistory = [];
let searchResults = [];
let currentResultIndex = -1;
let currentActiveChat = { type: null, id: null, receiverId: null, name: null };
let unreadCounts = {};
let currentRoomList = [];
let currentOnlineUsers = [];

function getMessageContentPreview(msg) {
    if (msg.text) {
        return msg.text;
    }
    if (msg.file && msg.file.name) {
        const extension = msg.file.name.split('.').pop().toLowerCase();
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
        if (imageExtensions.includes(extension)) {
            return '[Hình ảnh]';
        } else {
            return `[Tệp tin] ${msg.file.name}`;
        }
    }
    return '';
}

// Khi nhấn nút kẹp giấy, kích hoạt input file ẩn
uploadBtn.addEventListener('click', () => {
    fileInput.click();
});

// Khi người dùng đã chọn một file
fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (file.size > 100 * 1024 * 1024) {
        showError('Tệp tin quá lớn. Vui lòng chọn tệp dưới 100MB.');
        fileInput.value = '';
        return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = '⏳';

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            },
            body: formData
        });

        if (!response.ok) throw new Error('Tải lên thất bại.');

        const data = await response.json();

        const payload = {
            text: input.value.trim(),
            file: {
                url: data.filePath,
                name: file.name
            }
        };

        if (currentReplyInfo) {
            payload.replyTo = { messageId: currentReplyInfo.messageId };
        }

        if (currentActiveChat.type === 'room') {
            socket.emit('chat message', payload);
        } else if (currentActiveChat.type === 'private') {
            payload.receiverUserId = currentActiveChat.receiverId;
            socket.emit('send private message', payload);
        }

        input.value = '';
        cancelReply();

    } catch (err) {
        showError(err.message || 'Lỗi khi tải tệp lên.');
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '📎';
        fileInput.value = '';
    }
});

function updateSidebarUI() {
    const currentRoomId = currentActiveChat.type === 'room' ? currentActiveChat.id : null;
    roomListDiv.innerHTML = '';
    currentRoomList.forEach(room => {
        const roomElement = document.createElement('div');
        roomElement.className = 'room-item';
        if (room === currentRoomId) {
            roomElement.classList.add('active');
        }
        const unreadCount = unreadCounts[room];
        const badgeHtml = unreadCount ? `<span class="unread-badge">${unreadCount}</span>` : '';
        roomElement.innerHTML = `<span>${room}</span> ${badgeHtml}`;
        roomElement.setAttribute('data-room-id', room);
        roomElement.addEventListener('click', () => joinRoom(room, room));
        roomListDiv.appendChild(roomElement);
    });

    // --- Vẽ lại danh sách người dùng online ---
    const activePrivateChatReceiverId = (currentActiveChat.type === 'private') ? currentActiveChat.receiverId : null;
    userListUl.innerHTML = '';
    const onlineUsersToDisplay = currentOnlineUsers.filter(user => user.userId !== currentUserId);
    userCountSpan.textContent = onlineUsersToDisplay.length;
    onlineUsersToDisplay.forEach(user => {
        const userElement = document.createElement('li');
        userElement.setAttribute('data-user-id', user.userId);

        const chatParticipants = [currentUserId, user.userId].sort();
        const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
        const unreadCount = unreadCounts[privateChatId];
        const badgeHtml = unreadCount ? `<span class="unread-badge">${unreadCount}</span>` : '';

        if (user.userId === activePrivateChatReceiverId) {
            userElement.classList.add('active');
        }

        userElement.innerHTML = `
        <div class="status-dot"></div>
        <img src="${user.avatar}" alt="${user.username}" class="avatar-small">
        <span>${user.username}</span>
        ${badgeHtml}
    `;

        userElement.addEventListener('click', () => startPrivateChat(user.userId, user.username, user.avatar));
        userListUl.appendChild(userElement);
    });
}

// --- CÁC HÀM LẮNG NGHE SỰ KIỆN TỪ SERVER ---
socket.on('room list', (rooms) => {
    currentRoomList = rooms;
    updateSidebarUI();
});

socket.on('online users list', (users) => {
    currentOnlineUsers = users;
    updateSidebarUI();
});

socket.on('all_unread_counts', (counts) => {
    unreadCounts = counts || {};
    updateSidebarUI();
});

socket.on('unread_update', ({ chatId, count }) => {
    if (count > 0) {
        unreadCounts[chatId] = count;
    } else {
        delete unreadCounts[chatId];
    }
    updateSidebarUI();
});

// --- XỬ LÝ KHI TẢI LẠI TRANG ---
if (authToken && currentUsername && currentUserId) {
    authContainer.style.display = 'none';
    chatContainer.style.display = 'flex';
    currentUsernameSpan.textContent = currentUsername;
    socket.emit('authenticate', { token: authToken });
}

const storedChat = localStorage.getItem('currentActiveChat');
if (storedChat) {
    currentActiveChat = JSON.parse(storedChat);
}

function restoreActiveChat() {
    if (currentActiveChat.type === 'room' && currentActiveChat.id && currentActiveChat.name) {
        joinRoom(currentActiveChat.id, currentActiveChat.name);
    } else if (currentActiveChat.type === 'private' && currentActiveChat.receiverId && currentActiveChat.name) {
        startPrivateChat(currentActiveChat.receiverId, currentActiveChat.name);
    } else {
        messages.innerHTML = '<li class="system-message">👋 Chọn một phòng hoặc một người dùng để bắt đầu chat</li>';
        chatHeaderTitle.textContent = "Chào mừng";
        chatHeaderTitle.className = 'room-header';
        form.style.display = 'none';
    }
}
restoreActiveChat();

// --- CÁC HÀM TIỆN ÍCH VÀ XỬ LÝ GIAO DIỆN ---
function showAuthError(message) {
    authError.textContent = message;
    authError.style.display = 'block';
    setTimeout(() => { authError.style.display = 'none'; }, 5000);
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    messages.appendChild(errorDiv);
    messages.scrollTop = messages.scrollHeight;
    setTimeout(() => { errorDiv.remove(); }, 5000);
}

function showBrowserNotification(title, body, icon) {
    if (!("Notification" in window)) {
        console.log("Trình duyệt không hỗ trợ thông báo.");
        return;
    }

    if (Notification.permission === "granted") {
        new Notification(title, { body: body, icon: icon });
    } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then(function (permission) {
            if (permission === "granted") {
                new Notification(title, { body: body, icon: icon });
            }
        });
    }
}

function handleNewMessageNotification(msg) {
    // Chỉ kích hoạt nếu tab đang không được focus
    if (document.hidden) {
        notificationSound.volume = 0.4;
        notificationSound.play().catch(e => console.error("Lỗi phát âm thanh:", e));

        const sender = msg.user || msg.senderUsername;
        const previewText = getMessageContentPreview(msg);
        const avatar = msg.avatar;

        const body = previewText.length > 50 ? previewText.substring(0, 50) + '...' : previewText;

        showBrowserNotification(sender, body, avatar);
    }
}

toggleLink.addEventListener('click', () => { currentMode = currentMode === 'login' ? 'register' : 'login'; updateAuthForm(); });
toggleBtn.addEventListener('click', () => { currentMode = currentMode === 'login' ? 'register' : 'login'; updateAuthForm(); });

function updateAuthForm() {
    if (currentMode === 'register') {
        authTitle.textContent = 'Tạo Tài Khoản';
        submitBtn.textContent = 'Đăng Ký';
        toggleBtn.textContent = 'Đăng Nhập';
        toggleText.textContent = 'Đã có tài khoản? ';
        toggleLink.textContent = 'Đăng nhập ngay';
    } else {
        authTitle.textContent = 'Đăng Nhập';
        submitBtn.textContent = 'Đăng Nhập';
        toggleBtn.textContent = 'Tạo Tài Khoản';
        toggleText.textContent = 'Chưa có tài khoản? ';
        toggleLink.textContent = 'Đăng ký ngay';
    }
    authPassword.value = '';
    authError.style.display = 'none';
}

submitBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const username = authUsername.value.trim();
    const password = authPassword.value.trim();
    if (!username || !password) {
        showAuthError('Vui lòng nhập tên người dùng và mật khẩu');
        return;
    }
    if (currentMode === 'login') {
        socket.emit('login', { username, password });
    } else {
        socket.emit('register', { username, password });
    }
});

logoutBtn.addEventListener('click', () => {
    localStorage.clear();
    location.reload();
});

socket.on('auth_success', (data) => {
    localStorage.setItem('chatToken', data.token);
    localStorage.setItem('chatUsername', data.username);
    localStorage.setItem('chatUserId', data.userId);
    currentUsername = data.username;
    currentUserId = data.userId;
    authToken = data.token;
    authContainer.style.display = 'none';
    chatContainer.style.display = 'flex';
    currentUsernameSpan.textContent = data.username;
    socket.emit('authenticate', { token: data.token });
});

socket.on('auth_verified', (data) => {
    console.log('Xác thực thành công');
    currentUsernameSpan.textContent = data.username;
    currentUserId = data.userId;
    if (!currentActiveChat.type) {
        messages.innerHTML = '<li class="system-message">👋 Chọn một phòng hoặc một người dùng để bắt đầu chat</li>';
    }
});

socket.on('error', (message) => {
    if (chatContainer.style.display === 'flex') {
        showError(message);
    } else {
        showAuthError(message);
    }
});

socket.on('history', (history) => {
    messages.innerHTML = '';
    typingIndicator.textContent = '';
    typingUsers = {};

    history.forEach(msg => appendMessage(msg));
});

socket.on('chat message', (msg) => {
    const isForCurrentRoom = (currentActiveChat.type === 'room' && currentActiveChat.id === msg.roomId);

    if (isForCurrentRoom) {
        appendMessage(msg);

        socket.emit('mark_as_read', { chatId: currentActiveChat.id });
    }
});

socket.on('private chat history', ({ history }) => {
    messages.innerHTML = '';
    typingIndicator.textContent = '';
    typingUsers = {};

    history.forEach(msg => appendMessage(msg));
});

socket.on('private message', (msg) => {
    const isForCurrentChat =
        (msg.senderId === currentUserId && msg.receiverId === currentActiveChat.receiverId) ||
        (msg.senderId === currentActiveChat.receiverId && msg.receiverId === currentUserId);

    if (currentActiveChat.type === 'private' && isForCurrentChat) {
        appendMessage(msg);
        socket.emit('mark_as_read', { chatId: currentActiveChat.id });
    } else {
        const chatParticipants = [currentUserId, msg.senderId].sort();
        const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
        if (!unreadCounts[privateChatId]) unreadCounts[privateChatId] = 0;
        unreadCounts[privateChatId]++;
        updateSidebarUI();
    }
});

socket.on('user_typing', ({ username, chatId }) => {
    if (chatId === currentActiveChat.id) {
        typingUsers[username] = true;
        updateTypingIndicator();
    }
});

socket.on('user_stopped_typing', ({ username, chatId }) => {
    if (chatId === currentActiveChat.id) {
        delete typingUsers[username];
        updateTypingIndicator();
    }
});

function updateTypingIndicator() {
    const users = Object.keys(typingUsers);
    if (users.length === 0) {
        typingIndicator.textContent = '';
    } else if (users.length === 1) {
        typingIndicator.textContent = `${users[0]} đang gõ...`;
    } else if (users.length === 2) {
        typingIndicator.textContent = `${users[0]} và ${users[1]} đang gõ...`;
    } else {
        typingIndicator.textContent = `Nhiều người đang gõ...`;
    }
}

const formatTime = (timestamp) => new Date(timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

const appendMessage = (msg) => {
    messagesOnScreen.set(msg.messageId, msg);
    const existingItem = document.querySelector(`li[data-message-id="${msg.messageId}"]`);
    const item = existingItem || document.createElement('li');
    if (!existingItem) {
        item.setAttribute('data-message-id', msg.messageId);
    }

    let messageSender = msg.user || msg.senderUsername;
    let messageAvatar = msg.avatar;
    let isSentMessage = (msg.userId === currentUserId) || (msg.senderId === currentUserId);

    if (msg.isSystem) {
        item.className = 'system-message';
        item.innerHTML = msg.text;
    } else {
        let replyHtml = '';
        if (msg.replyTo) {
            if (msg.replyTo.isDeleted) {
                replyHtml = `
                    <div class="reply-quote-container" style="font-style: italic; opacity: 0.7;">
                        <div class="reply-quote-text">${msg.replyTo.text}</div>
                    </div>
                `;
            } else {
                const repliedUser = msg.replyTo.user || msg.replyTo.senderUsername;
                replyHtml = `
                    <div class="reply-quote-container" onclick="scrollToMessage('${msg.replyTo.messageId}')">
                        <div class="reply-quote-user">${repliedUser}</div>
                        <div class="reply-quote-text">${msg.replyTo.text}</div>
                    </div>
                `;
            }
        }
        let fileHtml = '';
        if (msg.file && msg.file.url) {
            const extension = msg.file.name.split('.').pop().toLowerCase();
            const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

            if (imageExtensions.includes(extension)) {
                fileHtml = `<img src="${msg.file.url}" class="message-image" alt="Hình ảnh đính kèm" onclick="window.open('${msg.file.url}', '_blank')">`;
            } else {
                fileHtml = `<a href="${msg.file.url}" target="_blank" download="${msg.file.name}" class="message-file-link">📄 ${msg.file.name}</a>`;
            }
        }

        let reactionsHtml = '';
        if (msg.reactions && Object.keys(msg.reactions).length > 0) {
            reactionsHtml = '<div class="reactions-container">';
            for (const emoji in msg.reactions) {
                const count = msg.reactions[emoji].length;
                if (count > 0) {
                    reactionsHtml += `<div class="reaction-item"><span>${emoji}</span><span class="count">${count}</span></div>`;
                }
            }
            reactionsHtml += '</div>';
        }

        const avatarImg = messageAvatar ? `<img src="${messageAvatar}" alt="${messageSender}" class="message-avatar">` : '';
        const editedIndicator = msg.edited ? '<span class="edited-indicator">(đã sửa)</span>' : '';

        const actionsHtml = `
    <div class="message-actions">
        <div style="position: relative;">
            <button class="action-btn react-btn" onclick="showReactionPicker(event, '${msg.messageId}')">😊</button>
            <div id="reaction-picker-${msg.messageId}" class="reaction-picker">
                <span onclick="addReaction('${msg.messageId}', '👍')">👍</span>
                <span onclick="addReaction('${msg.messageId}', '❤️')">❤️</span>
                <span onclick="addReaction('${msg.messageId}', '😂')">😂</span>
                <span onclick="addReaction('${msg.messageId}', '😮')">😮</span>
                <span onclick="addReaction('${msg.messageId}', '😢')">😢</span>
                <span onclick="addReaction('${msg.messageId}', '😡')">😡</span>
            </div>
        </div>
        
        ${isSentMessage ? `
            <!-- Menu cho tin nhắn của BẠN (hiện bên trái) -->
            <div style="position: relative;">
                <button class="action-btn more-btn" onclick="toggleMoreMenu(event, '${msg.messageId}')">⋯</button>
                <div id="more-menu-${msg.messageId}" class="more-actions-menu">
                    <button onclick="showEditInput('${msg.messageId}')">✏️ Sửa</button>
                    <button onclick="deleteMessage('${msg.messageId}')">🗑️ Xóa</button>
                    <button onclick="pinMessage('${msg.messageId}')">📌 Ghim</button>
                    <button onclick="initiateReply('${msg.messageId}')">↩️ Trả lời</button> 
                </div>
            </div>
        ` : `
            <!-- Menu cho tin nhắn của NGƯỜI KHÁC (hiện bên phải) -->
            <div style="position: relative;">
                <button class="action-btn more-btn" onclick="toggleMoreMenuRight(event, '${msg.messageId}')">⋯</button>
                <div id="more-menu-right-${msg.messageId}" class="more-actions-menu-right">
                    <button onclick="pinMessage('${msg.messageId}')">📌 Ghim</button>
                    <button onclick="initiateReply('${msg.messageId}')">↩️ Trả lời</button>
                </div>
            </div>
        `}
    </div>
`;

        item.innerHTML = `
${avatarImg}
<div class="bubble-container">
    <div class="message-content">
        <span class="user">${messageSender}</span>
        ${replyHtml}
        ${fileHtml}
        <div class="message-text">${msg.text}</div>
        <span class="timestamp">${formatTime(msg.timestamp)}${editedIndicator}</span>
        ${reactionsHtml} 
    </div>
</div>
${actionsHtml}
`;

        item.className = '';
        item.classList.add(isSentMessage ? 'sent-message' : 'received-message');
    }

    if (!existingItem) {
        messages.appendChild(item);
        messages.scrollTop = messages.scrollHeight;
    }
};

function toggleMoreMenu(event, messageId) {
    event.stopPropagation();
    const menu = document.getElementById(`more-menu-${messageId}`);
    document.querySelectorAll('.more-actions-menu, .more-actions-menu-right, .reaction-picker').forEach(m => {
        if (m.id !== menu.id) m.classList.remove('active');
    });
    menu.classList.toggle('active');
}

function toggleMoreMenuRight(event, messageId) {
    event.stopPropagation();
    const menu = document.getElementById(`more-menu-right-${messageId}`);
    document.querySelectorAll('.more-actions-menu, .more-actions-menu-right, .reaction-picker').forEach(m => {
        if (m.id !== menu.id) m.classList.remove('active');
    });
    menu.classList.toggle('active');
}

function showReactionPicker(event, messageId) {
    event.stopPropagation();
    const picker = document.getElementById(`reaction-picker-${messageId}`);
    document.querySelectorAll('.more-actions-menu, .reaction-picker').forEach(m => {
        if (m.id !== picker.id) m.classList.remove('active');
    });
    picker.classList.toggle('active');
}

function addReaction(messageId, emoji) {
    socket.emit('react to message', { messageId, emoji, chatId: currentActiveChat.id });
    document.querySelectorAll('.reaction-picker').forEach(m => m.classList.remove('active'));
}

window.addEventListener('click', () => {
    document.querySelectorAll('.more-actions-menu, .more-actions-menu-right, .reaction-picker').forEach(m => m.classList.remove('active'));
});

socket.on('message reacted', (updatedMessage) => {
    appendMessage(updatedMessage);
});

function showEditInput(messageId) {
    const messageElement = document.querySelector(`li[data-message-id="${messageId}"]`);
    if (!messageElement) return;
    const messageTextDiv = messageElement.querySelector('.message-text');
    if (!messageTextDiv) return;
    const currentText = messageTextDiv.innerText;
    messageTextDiv.innerHTML = `
    <div class="edit-container">
        <textarea class="edit-textarea" rows="3">${currentText}</textarea>
        <div class="edit-actions">
            <button class="edit-btn edit-btn-cancel" onclick="cancelEdit('${messageId}', \`${currentText.replace(/`/g, "\\`")}\`)">Hủy</button>
            <button class="edit-btn edit-btn-save" onclick="submitEdit('${messageId}')">Lưu</button>
        </div>
    </div>
`;
    messageTextDiv.querySelector('.edit-textarea').focus();
    document.querySelectorAll('.more-actions-menu').forEach(m => m.classList.remove('active'));
}

function cancelEdit(messageId, originalText) {
    const messageElement = document.querySelector(`li[data-message-id="${messageId}"]`);
    if (!messageElement) return;
    const messageTextDiv = messageElement.querySelector('.message-text');
    messageTextDiv.innerHTML = originalText;
}

function submitEdit(messageId) {
    const messageElement = document.querySelector(`li[data-message-id="${messageId}"]`);
    if (!messageElement) return;
    const editTextarea = messageElement.querySelector('.edit-textarea');
    if (!editTextarea) return;
    const newText = editTextarea.value.trim();
    if (newText) {
        socket.emit('edit message', { messageId, newText, chatId: currentActiveChat.id });
    }
}

const replyPreview = document.getElementById('replyPreview');

// Hàm được gọi khi nhấn nút "Trả lời"
function initiateReply(messageId) {
    const originalMessage = messagesOnScreen.get(messageId);
    if (!originalMessage) return;

    const user = originalMessage.user || originalMessage.senderUsername;
    const previewText = getMessageContentPreview(originalMessage);

    currentReplyInfo = {
        messageId,
        user,
        text: previewText
    };

    replyPreview.innerHTML = `
        <div class="reply-preview-content">
            <div class="reply-preview-user">Đang trả lời ${user}</div>
            <div class="reply-preview-text">${previewText}</div>
            <button class="cancel-reply-btn" onclick="cancelReply()">×</button>
        </div>
    `;
    replyPreview.style.display = 'block';
    input.focus();
}

// Hàm để hủy trạng thái trả lời
function cancelReply() {
    currentReplyInfo = null;
    replyPreview.style.display = 'none';
    replyPreview.innerHTML = '';
}

// Hàm để cuộn đến tin nhắn gốc
function scrollToMessage(messageId) {
    const targetMessage = document.querySelector(`li[data-message-id="${messageId}"]`);
    if (targetMessage) {
        targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });

        targetMessage.style.transition = 'background-color 0.5s';
        targetMessage.style.backgroundColor = 'rgba(255, 229, 100, 0.5)';
        setTimeout(() => {
            targetMessage.style.backgroundColor = '';
        }, 2000);
    } else {
        console.log("Không tìm thấy tin nhắn để cuộn đến.");
    }
}

function deleteMessage(messageId) {
    if (confirm('Bạn có chắc muốn xóa tin nhắn này không?')) {
        socket.emit('delete message', { messageId, chatId: currentActiveChat.id });
    }
    document.querySelectorAll('.more-actions-menu').forEach(m => m.classList.remove('active'));
}

socket.on('message edited', (updatedMessage) => {
    appendMessage(updatedMessage);
});

socket.on('message deleted', ({ messageId }) => {
    messagesOnScreen.delete(messageId);
    if (messageId === currentPinnedMessageId) {
        pinnedMessageBar.innerHTML = `<strong>📌 Tin nhắn đã ghim đã bị xóa.</strong>`;
        pinnedMessageBar.onclick = null;
        currentPinnedMessageId = null;
    }

    const messageElement = document.querySelector(`li[data-message-id="${messageId}"]`);
    if (messageElement) {
        messageElement.remove();
    }
});

form.addEventListener('submit', (e) => {
    e.preventDefault();
    const messageText = input.value.trim();
    if (messageText) {
        const payload = { text: messageText };

        if (currentReplyInfo) {
            payload.replyTo = { messageId: currentReplyInfo.messageId };
        }

        if (currentActiveChat.type === 'room') {
            socket.emit('chat message', payload);
        } else if (currentActiveChat.type === 'private') {
            payload.receiverUserId = currentActiveChat.receiverId;
            socket.emit('send private message', payload);
        }

        input.value = '';
        input.focus();
        cancelReply();
    }
});

input.addEventListener('input', () => {
    socket.emit('start_typing', { chatId: currentActiveChat.id });

    clearTimeout(typingTimeout);

    typingTimeout = setTimeout(() => {
        socket.emit('stop_typing', { chatId: currentActiveChat.id });
    }, 2000);
});

function joinRoom(roomId, roomName) {
    if (currentActiveChat.type === 'room' && currentActiveChat.id === roomId) return;
    document.querySelectorAll('.room-item, #user-list li').forEach(el => el.classList.remove('active'));
    const newRoomElement = document.querySelector(`.room-item[data-room-id="${roomId}"]`);
    if (newRoomElement) newRoomElement.classList.add('active');

    currentActiveChat = { type: 'room', id: roomId, name: roomName };
    socket.emit('join room', { roomId });

    messages.innerHTML = '';
    typingIndicator.textContent = '';
    typingUsers = {};
    localStorage.setItem('currentActiveChat', JSON.stringify(currentActiveChat));
    chatHeaderTitle.textContent = roomName;
    chatHeaderTitle.className = 'room-header';
    form.style.display = 'flex';
    input.focus();
}

function startPrivateChat(userId, username, avatar) {
    if (userId === currentUserId) return;
    const chatParticipants = [currentUserId, userId].sort();
    const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
    if (currentActiveChat.type === 'private' && currentActiveChat.id === privateChatId) return;

    document.querySelectorAll('.room-item, #user-list li').forEach(el => el.classList.remove('active'));
    const newUserElement = document.querySelector(`#user-list li[data-user-id="${userId}"]`);
    if (newUserElement) newUserElement.classList.add('active');

    currentActiveChat = { type: 'private', id: privateChatId, receiverId: userId, name: username };
    socket.emit('get private history', { targetUserId: userId });

    messages.innerHTML = '';
    typingIndicator.textContent = '';
    typingUsers = {};
    localStorage.setItem('currentActiveChat', JSON.stringify(currentActiveChat));
    chatHeaderTitle.textContent = username;
    chatHeaderTitle.className = 'private-header';
    form.style.display = 'flex';
    input.focus();
}

createRoomBtn.addEventListener('click', () => {
    const roomName = newRoomNameInput.value.trim();
    if (roomName) {
        socket.emit('create room', { roomName });
        newRoomNameInput.value = '';
    } else {
        showError('Vui lòng nhập tên phòng');
    }
});

newRoomNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        createRoomBtn.click();
    }
});

socket.on('room created', (roomName) => {
    showError(`Phòng "${roomName}" đã được tạo thành công`);
});

searchBtn.addEventListener('click', () => {
    if (!currentActiveChat.id) return;

    searchContainer.classList.add('active');
    searchInput.focus();

    socket.emit('get full history', { chatId: currentActiveChat.id }, (history) => {
        fullHistory = history;
        console.log(`Đã tải ${fullHistory.length} tin nhắn để sẵn sàng tìm kiếm.`);
    });
});

closeSearchBtn.addEventListener('click', () => {
    searchContainer.classList.remove('active');
    clearHighlights();
    searchInput.value = '';
    fullHistory = [];
    searchResults = [];
});

searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const searchTerm = searchInput.value.trim().toLowerCase();
        if (!searchTerm) return;

        clearHighlights();
        searchResults = [];

        for (let i = fullHistory.length - 1; i >= 0; i--) {
            if (fullHistory[i].text.toLowerCase().includes(searchTerm)) {
                searchResults.push(fullHistory[i].messageId);
            }
        }

        if (searchResults.length > 0) {
            currentResultIndex = 0;
            updateSearchUI();
        } else {
            searchCount.textContent = '0/0';
            prevResultBtn.disabled = true;
            nextResultBtn.disabled = true;
        }
    }
});

nextResultBtn.addEventListener('click', () => {
    if (currentResultIndex < searchResults.length - 1) {
        currentResultIndex++;
        updateSearchUI();
    }
});

prevResultBtn.addEventListener('click', () => {
    if (currentResultIndex > 0) {
        currentResultIndex--;
        updateSearchUI();
    }
});

function updateSearchUI() {
    searchCount.textContent = `${currentResultIndex + 1}/${searchResults.length}`;
    prevResultBtn.disabled = currentResultIndex === 0;
    nextResultBtn.disabled = currentResultIndex === searchResults.length - 1;

    highlightMessage(searchResults[currentResultIndex]);
}

function highlightMessage(messageId) {
    clearHighlights();

    let messageElement = document.querySelector(`li[data-message-id="${messageId}"]`);

    if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

        const textElement = messageElement.querySelector('.message-text');
        const searchTerm = searchInput.value;
        const regex = new RegExp(`(${escapeRegExp(searchTerm)})`, 'gi');
        textElement.innerHTML = textElement.innerText.replace(regex, `<span class="highlight">$1</span>`);
    } else {
        alert("Tin nhắn này quá cũ và chưa được hiển thị trên màn hình.");
    }
}

function clearHighlights() {
    document.querySelectorAll('.highlight').forEach(el => {
        const parent = el.parentNode;
        if (parent) {
            parent.innerHTML = parent.innerText;
        }
    });
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pinMessage(messageId) {
    socket.emit('pin_message', { messageId, chatId: currentActiveChat.id });
    document.querySelectorAll('.more-actions-menu').forEach(m => m.classList.remove('active'));
}

// Thay thế sự kiện message_pinned cũ
socket.on('message_pinned', ({ chatId, pinnedMessage }) => {
    if (chatId !== currentActiveChat.id) return;

    if (pinnedMessage) {
        currentPinnedMessageId = pinnedMessage.messageId;
        const previewText = getMessageContentPreview(pinnedMessage);

        pinnedMessageBar.innerHTML = `
    <strong>📌 Tin nhắn đã ghim:</strong> 
    <span>${pinnedMessage.user || pinnedMessage.senderUsername}: ${previewText}</span>
`;
        pinnedMessageBar.classList.add('active');
        pinnedMessageBar.onclick = () => {
            const targetMessage = document.querySelector(`li[data-message-id="${pinnedMessage.messageId}"]`);
            if (targetMessage) {
                targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetMessage.style.transition = 'background-color 0.5s';
                targetMessage.style.backgroundColor = 'rgba(255, 229, 100, 0.5)';
                setTimeout(() => {
                    targetMessage.style.backgroundColor = '';
                }, 2000);
            }
        };
    } else {
        currentPinnedMessageId = null;
        pinnedMessageBar.classList.remove('active');
        pinnedMessageBar.innerHTML = '';
        pinnedMessageBar.onclick = null;
    }
});

function resetPinnedMessageBar() {
    pinnedMessageBar.classList.remove('active');
    pinnedMessageBar.innerHTML = '';
    pinnedMessageBar.onclick = null;
}

const originalJoinRoom = joinRoom;
joinRoom = function (roomId, roomName) {
    resetPinnedMessageBar();
    originalJoinRoom(roomId, roomName);
}

const originalStartPrivateChat = startPrivateChat;
startPrivateChat = function (userId, username, avatar) {
    resetPinnedMessageBar();
    originalStartPrivateChat(userId, username, avatar);
}

socket.on('new_message_notification', (msg) => {
    handleNewMessageNotification(msg);
});
