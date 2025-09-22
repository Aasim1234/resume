// server.js
// Simple demo backend for file uploads + payment verification
// NOT production-ready. Read notes below.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// storage directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SCREEN_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR);

// simple storage; in production use a database
const DB_FILE = path.join(__dirname, 'db.json');
let DB = { approved: {}, payments: [] };
if (fs.existsSync(DB_FILE)) {
  try { DB = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ console.error(e) }
}
function saveDB(){ fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }

// multer setup
const upload = multer({ dest: SCREEN_DIR });

// Admin upload endpoint (uploads course files)
const uploadCourse = multer({ dest: UPLOAD_DIR });
app.post('/api/upload', uploadCourse.array('files'), (req, res) => {
  const adminKey = req.body.adminKey;
  if (adminKey !== (process.env.ADMIN_KEY || 'CHANGE_THIS_TO_A_SECRET')) {
    return res.status(401).json({ success:false, message:'Unauthorized' });
  }
  // files are already saved to UPLOAD_DIR by multer with random names
  // rename to original names for convenience (avoid collisions in real app)
  req.files.forEach(f => {
    const safe = path.basename(f.originalname).replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(UPLOAD_DIR, safe);
    fs.renameSync(f.path, dest);
  });
  const files = fs.readdirSync(UPLOAD_DIR);
  return res.json({ success:true, message:'Uploaded', files });
});

// Buyer submits payment evidence for verification
app.post('/api/submit-payment', upload.single('screenshot'), (req, res) => {
  const email = req.body.email;
  const txn = req.body.txn;
  if (!email || !txn) return res.status(400).json({ success:false, message:'Missing fields' });

  const record = { email, txn, time: new Date().toISOString(), screenshot: null };
  if (req.file) {
    // keep screenshot filename
    const dest = path.join(SCREEN_DIR, req.file.originalname);
    fs.renameSync(req.file.path, dest);
    record.screenshot = req.file.originalname;
  }

  DB.payments.push(record);

  // DEMO behavior: auto-approve. In production, set success:false and have admin verify,
  // or implement verification with a payment gateway or bank APIs.
  DB.approved[email] = { txn, verifiedAt: new Date().toISOString() };
  saveDB();

  return res.json({ success:true, message:'Payment received and approved (demo)' });
});

// List available course files if email approved
app.get('/api/list-content', (req, res) => {
  const email = req.query.email;
  if (!email) return res.json({ allowed:false });

  if (DB.approved[email]) {
    const files = fs.readdirSync(UPLOAD_DIR);
    return res.json({ allowed:true, files });
  }
  return res.json({ allowed:false });
});

// Serve protected file only if approved
app.get('/content/:file', (req, res) => {
  const email = req.query.email;
  const fname = req.params.file;
  if (!email || !DB.approved[email]) return res.status(403).send('Not authorized');

  const filePath = path.join(UPLOAD_DIR, fname);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath);
});

// static hosting for the site (if you put the HTML in public/)
app.use(express.static('public'));

app.listen(PORT, ()=> console.log('Server listening on', PORT));
