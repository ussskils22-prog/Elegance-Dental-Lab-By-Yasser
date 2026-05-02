const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadRoot = path.join(__dirname, '..', 'uploads', 'cases');
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`);
  },
});

const imageFileFilter = (_req, file, cb) => {
  const mime = (file.mimetype || '').toLowerCase();
  if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime)) {
    return cb(null, true);
  }
  cb(new Error('Unsupported image type. Allowed: JPEG, PNG, WEBP'));
};

const uploadCaseImage = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const plyStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, _file, cb) => {
    cb(null, `ply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.ply`);
  },
});

const plyFileFilter = (_req, file, cb) => {
  const raw = String(file.originalname || '').trim();
  const base =
    raw
      .split(/[/\\]/)
      .pop()
      ?.trim()
      ?.replace(/^\uFEFF/, '') ?? '';
  if (/\.ply$/i.test(base)) {
    return cb(null, true);
  }
  return cb(new Error('Only .ply scan files are allowed (.ply suffix on file name).'));
};

const uploadCasePly = multer({
  storage: plyStorage,
  fileFilter: plyFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — مسوحات ثلاثية الأبعاد
});

module.exports = {
  uploadCaseImage,
  uploadCasePly,
};
