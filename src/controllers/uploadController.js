exports.uploadFile = (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Không có tệp nào được tải lên.' });
    }
    // Trả về đường dẫn tương đối để client truy cập
    const filePath = `/uploads/${req.file.filename}`;
    res.json({ filePath });
};
