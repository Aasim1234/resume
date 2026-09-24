// server.js
// Course landing page + UPI payment-evidence submission + gated course downloads.
//
// IMPORTANT: a UPI transfer to a personal/merchant UPI ID cannot be verified
// automatically without a payment gateway or bank API. Every submission is
// stored as "pending" until an admin approves it (see README.md).
// DEMO_AUTO_APPROVE=true skips that check and is for local testing only;
// the server refuses to start with it when NODE_ENV=production.

'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration (all from environment / .env — see .env.example)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const DEMO_AUTO_APPROVE = process.env.DEMO_AUTO_APPROVE === 'true';
const UPI_ID = (process.env.UPI_ID || '').trim();
const UPI_PAYEE_NAME = (process.env.UPI_PAYEE_NAME || 'Hyderabad Trainer').trim();
const COURSE_PRICE_INR = positiveNumber(process.env.COURSE_PRICE_INR, 900);
const MAX_SCREENSHOT_MB = positiveNumber(process.env.MAX_SCREENSHOT_MB, 5);
const MAX_COURSE_FILE_MB = positiveNumber(process.env.MAX_COURSE_FILE_MB, 1024);

// Old demo default — treat it as "not set" so it can never act as a backdoor.
const INSECURE_ADMIN_KEYS = new Set(['', 'CHANGE_THIS_TO_A_SECRET']);
const ADMIN_ENABLED = !INSECURE_ADMIN_KEYS.has(ADMIN_KEY);

if (IS_PROD && DEMO_AUTO_APPROVE) {
  console.error('Refusing to start: DEMO_AUTO_APPROVE=true is not allowed when NODE_ENV=production.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths. index.html lives in the project root; CSS/JS assets live in public/.
// Only public/ is served statically — never the project root, which holds
// server.js, .env, db.json, uploads/ and screenshots/.
// ---------------------------------------------------------------------------
const ROOT_DIR = __dirname;
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT_DIR);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');       // paid course files
const SCREEN_DIR = path.join(DATA_DIR, 'screenshots');   // buyer payment screenshots
const TMP_DIR = path.join(DATA_DIR, 'tmp');              // multer staging area
const DB_FILE = path.join(DATA_DIR, 'db.json');

for (const dir of [UPLOAD_DIR, SCREEN_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------------------
// Tiny JSON "database" (swap for a real DB before handling real volume)
// ---------------------------------------------------------------------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { approved: {}, payments: [] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    // Don't start with an empty DB — the first save would wipe the real one.
    console.error(`Could not parse ${DB_FILE}: ${err.message}. Fix or move the file, then restart.`);
    process.exit(1);
  }
  const db = {
    approved: data.approved && typeof data.approved === 'object' ? data.approved : {},
    payments: Array.isArray(data.payments) ? data.payments : [],
  };
  // Upgrade records written by the old demo server (no id/status/tokens).
  for (const p of db.payments) {
    if (!p.id) p.id = crypto.randomUUID();
    if (p.email) p.email = String(p.email).trim().toLowerCase();
    if (!p.status) p.status = db.approved[p.email] ? 'approved' : 'pending';
    if (!Array.isArray(p.tokenHashes)) p.tokenHashes = [];
  }
  return db;
}

const DB = loadDB();

function saveDB() {
  // Write-then-rename so a crash mid-write can't leave a truncated db.json.
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TXN_RE = /^[A-Za-z0-9-]{6,40}$/;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function hashToken(token) {
  return sha256(token).toString('hex');
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Turn an uploaded file's original name into something safe to store on disk.
function safeFileName(original) {
  let name = path.basename(String(original || ''))
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')      // no hidden files / leading dots
    .replace(/[.\s]+$/, '')      // Windows strips trailing dots/spaces
    .slice(0, 200);
  if (!name) name = 'file';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

// "notes.pdf" -> "notes (1).pdf" if it already exists, instead of overwriting.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

// Resolve a requested file name inside `dir`, rejecting any path traversal.
function resolveFileIn(dir, requested) {
  const name = String(requested || '');
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null;
  const full = path.join(dir, name);
  if (path.dirname(full) !== dir) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function removeUploaded(files) {
  for (const f of files || []) fs.rm(f.path, { force: true }, () => {});
}

const IMAGE_SIGNATURES = {
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.webp': (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};

// Check the file's real content, not just the name/MIME type the browser claims.
function hasImageSignature(filePath, ext) {
  const check = IMAGE_SIGNATURES[ext];
  if (!check) return false;
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  return check(buf);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function isAdmin(req) {
  if (!ADMIN_ENABLED) return false;
  const given = req.get('x-admin-key') || (req.body && req.body.adminKey) || '';
  return crypto.timingSafeEqual(sha256(given), sha256(ADMIN_KEY));
}

function requireAdmin(req, res, next) {
  if (!ADMIN_ENABLED) {
    return res.status(503).json({ success: false, error: 'Admin endpoints are disabled. Set ADMIN_KEY in .env and restart.' });
  }
  if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

const ACCESS_COOKIE = 'course_access';
const MAX_TOKENS_PER_PAYMENT = 10;

// The buyer's browser holds a random token (HttpOnly cookie); db.json only
// stores its hash. Knowing someone's email is not enough to get their access.
function findAccessRecord(req) {
  const token = readCookie(req, ACCESS_COOKIE);
  if (!token) return null;
  const h = hashToken(token);
  return DB.payments.find((p) => p.tokenHashes.includes(h)) || null;
}

function issueAccessToken(req, res, record) {
  const token = crypto.randomBytes(32).toString('base64url');
  record.tokenHashes.push(hashToken(token));
  if (record.tokenHashes.length > MAX_TOKENS_PER_PAYMENT) record.tokenHashes.shift();
  res.cookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

function publicPayment(p) {
  const { tokenHashes, ...rest } = p;
  return rest;
}

function setStatus(record, status, by) {
  record.status = status;
  record.reviewedAt = new Date().toISOString();
  record.reviewedBy = by;
  if (status === 'approved') {
    DB.approved[record.email] = { txn: record.txn, verifiedAt: record.reviewedAt };
  } else if (DB.approved[record.email] && DB.approved[record.email].txn === record.txn) {
    delete DB.approved[record.email];
  }
}

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------
const tmpStorage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});

const SCREENSHOT_TYPES = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
};

const screenshotUpload = multer({
  storage: tmpStorage,
  limits: { fileSize: MAX_SCREENSHOT_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = SCREENSHOT_TYPES[file.mimetype];
    if (!allowed || !allowed.includes(ext)) {
      return cb(new HttpError(400, 'Screenshot must be a PNG, JPG or WEBP image.'));
    }
    cb(null, true);
  },
});

const COURSE_FILE_EXTENSIONS = new Set([
  '.pdf', '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz',
  '.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.mp3',
  '.txt', '.md', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv',
  '.png', '.jpg', '.jpeg', '.webp',
  '.json', '.yaml', '.yml', '.sh', '.tf',
]);

const courseUpload = multer({
  storage: tmpStorage,
  limits: { fileSize: MAX_COURSE_FILE_MB * 1024 * 1024, files: 20, fields: 10, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => {
    // Runs before the file is written. With a form-field key, "adminKey" must be
    // sent before the files; the X-Admin-Key header always works.
    if (!isAdmin(req)) {
      return cb(new HttpError(401, 'Unauthorized (send X-Admin-Key header, or the adminKey field before the files).'));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!COURSE_FILE_EXTENSIONS.has(ext)) {
      return cb(new HttpError(400, `File type not allowed: ${ext || '(no extension)'}`));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      // Would break plain-http localhost; enable HTTPS at your proxy instead.
      'upgrade-insecure-requests': null,
    },
  },
}));
app.use(express.json({ limit: '100kb' }));

// ----- pages & static assets -----
app.get(['/', '/index.html'], (req, res) => res.sendFile(INDEX_FILE));
app.use(express.static(PUBLIC_DIR, { index: false }));

// ----- public API -----
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Payment details the page needs. The UPI ID is public by nature (it's shown to
// every buyer) — no secrets are ever sent from here.
app.get('/api/config', (req, res) => {
  res.json({
    paymentsEnabled: Boolean(UPI_ID),
    upiId: UPI_ID || null,
    payeeName: UPI_PAYEE_NAME,
    amount: COURSE_PRICE_INR,
    currency: 'INR',
    demoAutoApprove: DEMO_AUTO_APPROVE,
    maxScreenshotMb: MAX_SCREENSHOT_MB,
  });
});

// Buyer submits payment evidence (email + UPI transaction ID + optional screenshot).
app.post('/api/submit-payment', screenshotUpload.single('screenshot'), (req, res) => {
  const reject = (status, error) => {
    removeUploaded(req.file ? [req.file] : []);
    return res.status(status).json({ success: false, error });
  };

  if (!UPI_ID) return reject(503, 'Payments are not configured on this server yet.');

  const email = normalizeEmail(req.body && req.body.email);
  const txn = String((req.body && req.body.txn) || '').trim();
  if (!email) return reject(400, 'Please enter a valid email address.');
  if (!TXN_RE.test(txn)) return reject(400, 'Please enter the UPI transaction / reference ID (6–40 letters or digits).');

  let screenshotExt = null;
  if (req.file) {
    screenshotExt = path.extname(req.file.originalname).toLowerCase();
    if (!hasImageSignature(req.file.path, screenshotExt)) {
      return reject(400, 'The screenshot file is not a valid image.');
    }
  }

  let record = DB.payments.find((p) => String(p.txn).toLowerCase() === txn.toLowerCase());
  if (record && record.email !== email) {
    return reject(409, 'This transaction ID has already been submitted with a different email.');
  }

  const isNew = !record;
  if (isNew) {
    record = {
      id: crypto.randomUUID(),
      email,
      txn,
      time: new Date().toISOString(),
      screenshot: null,
      status: 'pending',
      tokenHashes: [],
    };
    DB.payments.push(record);
    if (DEMO_AUTO_APPROVE) setStatus(record, 'approved', 'DEMO_AUTO_APPROVE');
  }

  if (req.file) {
    if (record.screenshot) {
      removeUploaded([req.file]); // keep the first screenshot as evidence
    } else {
      const name = `${record.id}${screenshotExt}`;
      fs.renameSync(req.file.path, path.join(SCREEN_DIR, name));
      record.screenshot = name;
    }
  }

  // Same email + txn again (e.g. a new device) just re-links this browser.
  issueAccessToken(req, res, record);
  saveDB();

  const message = record.status === 'approved'
    ? (DEMO_AUTO_APPROVE ? 'Approved automatically (DEMO mode — no real verification).' : 'Payment verified. Enjoy the course!')
    : record.status === 'rejected'
      ? 'This payment was rejected. Contact the trainer if you believe this is a mistake.'
      : 'Thanks! Your payment is pending verification. This page will unlock once it is approved.';

  return res.status(isNew ? 201 : 200).json({ success: true, status: record.status, message });
});

// Course files for this browser's approved payment.
app.get('/api/list-content', (req, res) => {
  const record = findAccessRecord(req);
  if (!record) return res.json({ allowed: false, status: 'none' });
  if (record.status !== 'approved') return res.json({ allowed: false, status: record.status, email: record.email });
  return res.json({ allowed: true, status: 'approved', email: record.email, files: listFiles(UPLOAD_DIR) });
});

// Download a course file (approved buyers only).
app.get('/content/:file', (req, res, next) => {
  const record = findAccessRecord(req);
  if (!record || record.status !== 'approved') return res.status(403).type('text').send('Not authorized');
  const filePath = resolveFileIn(UPLOAD_DIR, req.params.file);
  if (!filePath) return res.status(404).type('text').send('Not found');
  res.download(filePath, (err) => { if (err && !res.headersSent) next(err); });
});

// ----- admin API (X-Admin-Key header) -----

// Upload course files. Multipart field "files" (up to 20).
app.post('/api/upload',
  (req, res, next) => {
    if (!ADMIN_ENABLED) return requireAdmin(req, res, next);
    // Reject a wrong header key before any bytes are written to disk.
    if (req.get('x-admin-key') && !isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    next();
  },
  courseUpload.array('files', 20),
  (req, res) => {
    const files = req.files || [];
    if (!isAdmin(req)) {
      removeUploaded(files);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files received. Use the multipart field name "files".' });
    }
    const saved = files.map((f) => {
      const dest = uniquePath(UPLOAD_DIR, safeFileName(f.originalname));
      fs.renameSync(f.path, dest);
      return path.basename(dest);
    });
    return res.json({ success: true, message: 'Uploaded', saved, files: listFiles(UPLOAD_DIR) });
  });

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const { status } = req.query;
  const payments = DB.payments
    .filter((p) => !status || p.status === status)
    .map(publicPayment);
  res.json({ success: true, payments });
});

app.post('/api/admin/payments/:id/:action', requireAdmin, (req, res) => {
  const { id, action } = req.params;
  const statusByAction = { approve: 'approved', reject: 'rejected' };
  if (!statusByAction[action]) return res.status(404).json({ success: false, error: 'Route not found' });
  const record = DB.payments.find((p) => p.id === id);
  if (!record) return res.status(404).json({ success: false, error: 'Payment not found' });
  setStatus(record, statusByAction[action], 'admin');
  saveDB();
  res.json({ success: true, payment: publicPayment(record) });
});

app.get('/api/admin/screenshots/:file', requireAdmin, (req, res, next) => {
  const filePath = resolveFileIn(SCREEN_DIR, req.params.file);
  if (!filePath) return res.status(404).json({ success: false, error: 'Not found' });
  res.sendFile(filePath, (err) => { if (err && !res.headersSent) next(err); });
});

// ----- 404s -----
app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));

// ----- errors -----
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'File is too large.',
  LIMIT_FILE_COUNT: 'Too many files.',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field.',
  LIMIT_FIELD_VALUE: 'A form field is too long.',
  LIMIT_FIELD_COUNT: 'Too many form fields.',
  LIMIT_PART_COUNT: 'Too many form parts.',
};

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = err.status || err.statusCode || 500;
  let message = err.expose || status < 500 ? err.message : 'Internal server error';

  if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = MULTER_MESSAGES[err.code] || err.message;
  } else if (err.type === 'entity.parse.failed') {
    message = 'Invalid JSON body.';
  }

  if (status >= 500) console.error(err);

  if (req.path.startsWith('/api')) return res.status(status).json({ success: false, error: message });
  return res.status(status).type('text').send(message);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other process or set PORT in .env.`);
      else console.error(err);
      process.exit(1);
    }
    console.log(`Server listening on http://localhost:${PORT}`);
    if (!UPI_ID) console.warn('WARNING: UPI_ID is not set — the payment form is disabled. See .env.example.');
    if (!ADMIN_ENABLED) console.warn('WARNING: ADMIN_KEY is not set — admin upload/approval endpoints are disabled.');
    if (DEMO_AUTO_APPROVE) console.warn('WARNING: DEMO_AUTO_APPROVE=true — every payment submission is approved WITHOUT verification.');
  });
}

module.exports = app;
