const socket = io();
let currentWatchingChatId = null;

// Lắng nghe tin nhắn real-time từ server
socket.on('admin_new_message', (newMessage) => {
    const messageChatId = newMessage.roomId || `private:${[newMessage.senderId, newMessage.receiverId].sort().join(':')}`;

    if (messageChatId === currentWatchingChatId) {
        const placeholder = document.getElementById('message-display-area').querySelector('p');
        if (placeholder && (placeholder.textContent.includes('Không tìm thấy') || placeholder.textContent.includes('Vui lòng chọn'))) {
            document.getElementById('message-display-area').innerHTML = '';
        }
        appendSingleMessage(newMessage);
        document.getElementById('message-display-area').scrollTop = document.getElementById('message-display-area').scrollHeight;
    }
});

socket.on('connect', () => {
    console.log('✅ Đã kết nối tới server với tư cách Admin');
});

// Lắng nghe tín hiệu từ server và tự động làm mới danh sách phòng
socket.on('admin_rooms_updated', () => {
    console.log('Nhận được cập nhật danh sách phòng, tải lại...');
    fetchRooms();
    if (document.getElementById('dashboard-section').classList.contains('active')) {
        loadDashboardStats();
    }
});

// Lắng nghe sự kiện cập nhật danh sách người dùng
socket.on('admin_users_updated', () => {
    console.log('Nhận được cập nhật danh sách người dùng, tải lại...');
    fetchUsers();
    if (document.getElementById('dashboard-section').classList.contains('active')) {
        loadDashboardStats();
    }
});

// === THÊM SỰ KIỆN MỚI ĐỂ CẬP NHẬT SỐ NGƯỜI ONLINE REAL-TIME ===
socket.on('online users list', (users) => {
    const onlineCountEl = document.getElementById('stat-online-users');
    if (onlineCountEl) {
        onlineCountEl.textContent = users.length;
    }
});

const navLinks = document.querySelectorAll('.nav-link');
const contentSections = document.querySelectorAll('.content-section');
const defaultRooms = ['Phòng Chung', 'Công Nghệ', 'Học Tập'];

function showSection(targetId) {
    navLinks.forEach(link => link.classList.remove('active'));
    contentSections.forEach(section => section.classList.remove('active'));

    const navLink = document.getElementById(`nav-${targetId}`);
    if (navLink) navLink.classList.add('active');
    if (targetId === 'backup') {
        fetchBackups();
    }

    const section = document.getElementById(`${targetId}-section`);
    if (section) section.classList.add('active');

    if (targetId === 'messages') {
        initializeMessageViewer();
    } else if (targetId === 'dashboard') {
        loadDashboardStats();
    }
    else {
        if (currentWatchingChatId) {
            socket.emit('admin_stop_watching_chat');
            currentWatchingChatId = null;
        }
    }
}

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = e.target.id.split('-')[1];
        showSection(targetId);
    });
});

// === LOGIC TẢI DỮ LIỆU ===
async function fetchUsers() {
    try {
        const response = await fetch('/api/admin/users');
        if (!response.ok) throw new Error('Lỗi tải dữ liệu người dùng.');

        const users = await response.json();
        const tableBody = document.querySelector('#usersTable tbody');
        tableBody.innerHTML = '';

        users.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));

        users.forEach(user => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${user.username}</strong></td>
                <td>${user.userId}</td>
                <td>${new Date(user.joinedAt).toLocaleString('vi-VN')}</td>
                <td>${user.messageCount}</td>
                <td>${user.status}</td>
                <td>
                    <button class="action-btn edit" data-user-id="${user.userId}" data-username="${user.username}">Sửa</button>
                    <button class="action-btn delete" data-user-id="${user.userId}" data-user-status="${user.status}" data-username="${user.username}">Xóa</button>
                </td>
            `;
            tableBody.appendChild(row);
        });
    } catch (err) {
        console.error(err);
        document.querySelector('#usersTable tbody').innerHTML = '<tr><td colspan="6" style="text-align: center; color: red;">Lỗi tải dữ liệu.</td></tr>';
    }
}

async function fetchRooms() {
    try {
        const response = await fetch('/api/admin/rooms');
        if (!response.ok) throw new Error('Lỗi tải dữ liệu phòng.');

        const rooms = await response.json();
        const tableBody = document.querySelector('#roomsTable tbody');
        tableBody.innerHTML = '';

        rooms.forEach(room => {
            const row = document.createElement('tr');
            const isDefault = defaultRooms.includes(room);
            row.innerHTML = `
                <td># ${room}</td>
                <td>
                    <button class="action-btn edit" data-room-name="${room}" ${isDefault ? 'disabled' : ''}>Sửa</button>
                    <button class="action-btn delete" data-room-name="${room}" ${isDefault ? 'disabled title="Không thể xóa phòng mặc định"' : ''}>Xóa</button>
                </td>
            `;
            tableBody.appendChild(row);
        });
    } catch (err) {
        console.error(err);
        document.querySelector('#roomsTable tbody').innerHTML = '<tr><td colspan="2" style="text-align: center; color: red;">Lỗi tải dữ liệu.</td></tr>';
    }
}
async function loadDashboardStats() {
    try {
        const response = await fetch('/api/admin/stats');
        if (!response.ok) {
            throw new Error('Lỗi tải dữ liệu thống kê.');
        }
        const stats = await response.json();

        document.getElementById('stat-online-users').textContent = stats.onlineUsers;
        document.getElementById('stat-total-users').textContent = stats.totalUsers;
        document.getElementById('stat-total-rooms').textContent = stats.totalRooms;
        document.getElementById('stat-total-messages').textContent = stats.totalMessages;

    } catch (err) {
        console.error(err);
    }
}

// HÀM MỚI ĐỂ XỬ LÝ XÓA PHÒNG
async function handleDeleteRoom(event) {
    const roomName = event.target.dataset.roomName;
    if (confirm(`Bạn có chắc chắn muốn xóa phòng "${roomName}" không? Mọi tin nhắn trong phòng sẽ bị mất.`)) {
        try {
            const response = await fetch('/api/admin/rooms', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomName: roomName })
            });
            if (!response.ok) {
                const result = await response.json();
                alert(result.message || 'Xóa thất bại.');
            }
        } catch (err) {
            alert('Đã xảy ra lỗi khi xóa phòng.');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    showSection('dashboard');
    fetchUsers();
    fetchRooms();
});

// Xử lý đăng xuất
document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/admin/logout', { method: 'POST' });
    window.location.href = '/admin/login'; // Changed from /admin-login.html
})

// Thêm phòng mới
document.getElementById('addRoomBtn').addEventListener('click', async () => {
    const input = document.getElementById('newRoomInput');
    const roomName = input.value.trim();
    if (!roomName) return alert('Vui lòng nhập tên phòng.');

    try {
        const response = await fetch('/api/admin/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName })
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.message);
        }
        input.value = '';
    } catch (err) { alert(`Lỗi: ${err.message}`); }
});

// Mở Modal Sửa hoặc Xóa
document.querySelector('#usersTable tbody').addEventListener('click', async (e) => {
    // Logic cho nút Sửa
    if (e.target.classList.contains('edit')) {
        const userId = e.target.dataset.userId;
        const username = e.target.dataset.username;
        const modal = document.getElementById('editUserModal');
        modal.dataset.userId = userId;
        document.getElementById('editUsernameInput').value = username;
        document.getElementById('editPasswordInput').value = '';
        modal.style.display = 'flex';
    }

    // >> LOGIC MỚI CHO NÚT XÓA
    if (e.target.classList.contains('delete')) {
        const userId = e.target.dataset.userId;
        const status = e.target.dataset.userStatus;
        const username = e.target.dataset.username;

        if (status === 'online') {
            alert('Không thể xóa người dùng đang online.');
            return;
        }

        if (confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn người dùng "${username}" không?`)) {
            try {
                const response = await fetch('/api/admin/users', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.message);
                }
            } catch (err) {
                alert(`Lỗi: ${err.message}`);
            }
        }
    }
});
document.querySelector('#roomsTable tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('edit')) {
        const roomName = e.target.dataset.roomName;
        const modal = document.getElementById('editRoomModal');
        const input = document.getElementById('editRoomNameInput');
        input.value = roomName;
        modal.dataset.oldRoomName = roomName;
        modal.style.display = 'flex';
    }
    if (e.target.classList.contains('delete')) {
        handleDeleteRoom(e.target.dataset.roomName); // This calls the function defined below? No, it calls the one defined above?
        // Wait, handleDeleteRoom takes event in one definition and roomName in another?
        // In original code:
        // Line 516: async function handleDeleteRoom(event) { ... }
        // Line 652: async function handleDeleteRoom(roomName) { ... }
        // It seems there were TWO definitions. JS will use the last one (hoisted).
        // The last one (line 652) takes roomName.
        // The event listener at line 618 calls `handleDeleteRoom(e.target.dataset.roomName)`. This matches the second definition.
        // The first definition (line 516) expects event.
        // I should keep the second one.
    }
});

// Xử lý trong Modal Sửa
const editModal = document.getElementById('editRoomModal');
document.getElementById('saveEditBtn').addEventListener('click', async () => {
    const oldRoomName = editModal.dataset.oldRoomName;
    const newRoomName = document.getElementById('editRoomNameInput').value.trim();

    if (!newRoomName || newRoomName === oldRoomName) {
        editModal.style.display = 'none';
        return;
    }

    try {
        const response = await fetch('/api/admin/rooms', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldRoomName, newRoomName })
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.message);
        }
        editModal.style.display = 'none';
    } catch (err) { alert(`Lỗi: ${err.message}`); }
});

document.getElementById('cancelEditBtn').addEventListener('click', () => {
    editModal.style.display = 'none';
});

// Hàm xử lý Xóa (The one that takes roomName)
async function handleDeleteRoom(roomName) {
    if (confirm(`Bạn có chắc chắn muốn xóa phòng "${roomName}" không?`)) {
        try {
            const response = await fetch('/api/admin/rooms', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomName })
            });
            if (!response.ok) {
                const result = await response.json();
                throw new Error(result.message || 'Xóa thất bại.');
            }
        } catch (err) { alert(`Lỗi: ${err.message}`); }
    }
}
// Mở modal thêm người dùng
document.getElementById('addUserBtn').addEventListener('click', () => {
    document.getElementById('addUserModal').style.display = 'flex';
});

// Hủy/Đóng các modal
document.getElementById('cancelEditUserBtn').addEventListener('click', () => {
    document.getElementById('editUserModal').style.display = 'none';
});
document.getElementById('cancelAddUserBtn').addEventListener('click', () => {
    document.getElementById('addUserModal').style.display = 'none';
});

// Lưu thay đổi khi SỬA người dùng
document.getElementById('saveEditUserBtn').addEventListener('click', async () => {
    const modal = document.getElementById('editUserModal');
    const userId = modal.dataset.userId;
    const newUsername = document.getElementById('editUsernameInput').value.trim();
    const newPassword = document.getElementById('editPasswordInput').value; // không trim

    try {
        const response = await fetch('/api/admin/users', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, newUsername, newPassword })
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.message);
        }
        modal.style.display = 'none';
    } catch (err) { alert(`Lỗi: ${err.message}`); }
});

// Lưu khi THÊM người dùng mới
document.getElementById('saveAddUserBtn').addEventListener('click', async () => {
    const username = document.getElementById('addUsernameInput').value.trim();
    const password = document.getElementById('addPasswordInput').value;

    try {
        const response = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.message);
        }
        document.getElementById('addUserModal').style.display = 'none';
        document.getElementById('addUsernameInput').value = '';
        document.getElementById('addPasswordInput').value = '';
    } catch (err) { alert(`Lỗi: ${err.message}`); }
});

// === LOGIC MỚI CHO TRÌNH XEM TIN NHẮN ===
const tabRoomChat = document.getElementById('tab-room-chat');
const tabPrivateChat = document.getElementById('tab-private-chat');
const roomControls = document.getElementById('room-chat-controls');
const privateControls = document.getElementById('private-chat-controls');
const roomSelect = document.getElementById('room-select');
const messageDisplayArea = document.getElementById('message-display-area');

// Hàm khởi tạo: Tải danh sách phòng cho dropdown
async function initializeMessageViewer() {
    try {
        const response = await fetch('/api/admin/rooms');
        if (!response.ok) throw new Error('Lỗi tải danh sách phòng.');
        const rooms = await response.json();

        roomSelect.innerHTML = '';
        rooms.forEach(room => {
            const option = document.createElement('option');
            option.value = room;
            option.textContent = room;
            roomSelect.appendChild(option);
        });
    } catch (err) {
        console.error(err);
        roomSelect.innerHTML = '<option value="">Lỗi tải phòng</option>';
    }
}

// Xử lý chuyển tab
tabRoomChat.addEventListener('click', () => {
    roomControls.style.display = 'block';
    privateControls.style.display = 'none';
    tabRoomChat.style.background = '#eee';
    tabPrivateChat.style.background = 'white';
});

tabPrivateChat.addEventListener('click', () => {
    roomControls.style.display = 'none';
    privateControls.style.display = 'block';
    tabRoomChat.style.background = 'white';
    tabPrivateChat.style.background = '#eee';
});

// Hàm chung để gọi API và hiển thị lịch sử
async function fetchAndDisplayHistory(url, chatId) {
    messageDisplayArea.innerHTML = '<p style="color: #777;">Đang tải lịch sử...</p>';

    // Ngừng theo dõi chat cũ trước khi bắt đầu chat mới
    if (currentWatchingChatId) {
        socket.emit('admin_stop_watching_chat');
    }
    currentWatchingChatId = chatId;
    try {
        const response = await fetch(url);
        const history = await response.json();

        if (!response.ok) {
            throw new Error(history.message || 'Lỗi không xác định.');
        }

        renderMessages(history);

        // BẮT ĐẦU THEO DÕI
        socket.emit('admin_watch_chat', { chatId });
        console.log(`CLIENT: Gửi yêu cầu theo dõi chatId: ${chatId}`);

    } catch (err) {
        messageDisplayArea.innerHTML = `<p style="color: red;">Lỗi: ${err.message}</p>`;
        currentWatchingChatId = null;
    }
}

// Hàm "vẽ" tin nhắn ra màn hình
function renderMessages(messages) {
    if (messages.length === 0) {
        messageDisplayArea.innerHTML = '<p style="color: #777;">Không tìm thấy tin nhắn nào.</p>';
        return;
    }

    messageDisplayArea.innerHTML = '';
    messages.forEach(msg => appendSingleMessage(msg));
}

function appendSingleMessage(msg) {
    const msgDiv = document.createElement('div');
    msgDiv.style.borderBottom = '1px solid #f0f0f0';
    msgDiv.style.padding = '10px 0';

    const sender = msg.user || msg.senderUsername;
    const timestamp = new Date(msg.timestamp).toLocaleString('vi-VN');

    let contentHtml = `<p style="margin: 0;">${msg.text || ''}</p>`;
    if (msg.file && msg.file.url) {
        contentHtml += `<a href="${msg.file.url}" target="_blank">Tệp đính kèm: ${msg.file.name}</a>`;
    }

    msgDiv.innerHTML = `
        <div>
            <strong style="color: #0056b3;">${sender}</strong>
            <small style="color: #888; margin-left: 10px;">${timestamp}</small>
        </div>
        ${contentHtml}
    `;
    messageDisplayArea.appendChild(msgDiv);
}

// Gắn sự kiện cho các nút "Xem"
document.getElementById('view-room-history-btn').addEventListener('click', () => {
    const selectedRoom = roomSelect.value;
    if (selectedRoom) {
        const url = `/api/admin/chat-history?type=room&roomName=${selectedRoom}`;
        fetchAndDisplayHistory(url, selectedRoom);
    }
});

document.getElementById('view-private-history-btn').addEventListener('click', async () => {
    const user1 = document.getElementById('user1-input').value.trim();
    const user2 = document.getElementById('user2-input').value.trim();
    if (!user1 || !user2) {
        return alert('Vui lòng nhập tên của cả hai người dùng.');
    }

    try {
        // Gọi API để lấy danh sách user và tìm ID
        const usersResponse = await fetch('/api/admin/users');
        if (!usersResponse.ok) throw new Error('Không thể lấy danh sách người dùng.');
        const users = await usersResponse.json();

        const user1Profile = users.find(u => u.username.toLowerCase() === user1.toLowerCase());
        const user2Profile = users.find(u => u.username.toLowerCase() === user2.toLowerCase());

        if (!user1Profile || !user2Profile) {
            return alert('Một hoặc hai người dùng không tồn tại.');
        }

        // Tạo privateChatId ở client
        const chatParticipants = [user1Profile.userId, user2Profile.userId].sort();
        const privateChatId = `private:${chatParticipants[0]}:${chatParticipants[1]}`;
        const url = `/api/admin/chat-history?type=private&user1=${user1}&user2=${user2}`;

        fetchAndDisplayHistory(url, privateChatId);
    } catch (error) {
        alert('Lỗi: ' + error.message);
    }
});

// --- LOGIC CHO SAO LƯU & KHÔI PHỤC ---
async function fetchBackups() {
    try {
        const response = await fetch('/api/admin/backups');
        if (!response.ok) throw new Error('Lỗi tải danh sách sao lưu.');
        const backups = await response.json();
        const tableBody = document.querySelector('#backupsTable tbody');
        tableBody.innerHTML = '';

        if (backups.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Chưa có bản sao lưu nào.</td></tr>';
            return;
        }

        backups.forEach(backup => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${backup.name}</td>
                <td>${new Date(backup.createdAt).toLocaleString('vi-VN')}</td>
                <td>${backup.size}</td>
                <td>
                    <button class="action-btn" onclick="restoreBackup('${backup.name}')" style="background: #2ecc71;" title="Khôi phục">🔄</button>
                    <button class="action-btn delete" onclick="deleteBackup('${backup.name}')" title="Xóa">🗑️</button>
                </td>
            `;
            tableBody.appendChild(row);
        });
    } catch (err) {
        console.error(err);
        document.querySelector('#backupsTable tbody').innerHTML = '<tr><td colspan="4" style="text-align: center; color: red;">Lỗi tải dữ liệu.</td></tr>';
    }
}

document.getElementById('createBackupBtn').addEventListener('click', async () => {
    const btn = document.getElementById('createBackupBtn');
    btn.disabled = true;
    btn.textContent = 'Đang xử lý...';
    try {
        const response = await fetch('/api/admin/backup', { method: 'POST' });
        const result = await response.json();
        alert(result.message);
        if (result.success) {
            fetchBackups();
        }
    } catch (err) {
        alert('Đã xảy ra lỗi khi tạo sao lưu.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Tạo bản sao lưu ngay';
    }
});

window.restoreBackup = async function (filename) {
    const confirmation = prompt(`CẢNH BÁO: Hành động này sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại bằng dữ liệu từ file "${filename}". Hành động này không thể hoàn tác.\n\nĐể xác nhận, vui lòng nhập "YES" vào ô bên dưới.`);
    if (confirmation !== 'YES') {
        alert('Hành động khôi phục đã bị hủy.');
        return;
    }

    try {
        const response = await fetch('/api/admin/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const result = await response.json();
        alert(result.message);
    } catch (err) {
        alert('Lỗi nghiêm trọng xảy ra. Vui lòng kiểm tra console của server.');
    }
}

window.deleteBackup = async function (filename) {
    if (confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn file sao lưu "${filename}" không?`)) {
        try {
            const response = await fetch(`/api/admin/backups/${filename}`, { method: 'DELETE' });
            const result = await response.json();
            if (result.success) {
                fetchBackups();
            } else {
                alert(result.message);
            }
        } catch (err) {
            alert('Đã xảy ra lỗi khi xóa file.');
        }
    }
}
