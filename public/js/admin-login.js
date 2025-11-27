document.getElementById('loginBtn').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorP = document.getElementById('error');
    errorP.textContent = '';

    try {
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (response.ok) {
            window.location.href = '/admin';
        } else {
            const result = await response.json();
            errorP.textContent = result.message;
        }
    } catch (err) {
        errorP.textContent = 'Đã xảy ra lỗi. Vui lòng thử lại.';
    }
});
