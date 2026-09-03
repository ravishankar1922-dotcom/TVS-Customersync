/**
 * BalanceSync — Backend (MERN)
 * Express + MongoDB API serving the React frontend + customer portal.
 */
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const path      = require('path');
const cfg       = require('./config');
const connectDB = require('./db');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: cfg.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan(cfg.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',           require('./routes/auth'));
app.use('/api/system',         require('./routes/system'));
app.use('/api/customers',      require('./routes/customers'));
app.use('/api/tokens',         require('./routes/tokens'));
app.use('/api/emails',         require('./routes/emails'));
app.use('/api/confirmations',  require('./routes/confirmations'));
app.use('/api/ledger',         require('./routes/ledger'));
app.use('/api/reconciliation', require('./routes/reconciliation'));
app.use('/api/dashboard',      require('./routes/dashboard'));
app.use('/api/audit',          require('./routes/audit'));

app.use('/storage/soa', express.static(path.join(cfg.UPLOAD_ROOT, 'soa')));

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Maximum 20 MB allowed.' });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function startup() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  BalanceSync — Backend (MERN)  ');
  console.log('══════════════════════════════════════════════');
  await connectDB();
  console.log(`  Cycle        : ${cfg.CYCLE_ID}`);
  console.log(`  Company      : ${cfg.COMPANY}`);
  console.log(`  As-of Date   : ${cfg.AS_OF_DATE}`);
  console.log('──────────────────────────────────────────────');

  const Admin = require('./models/Admin');
  const bcrypt = require('bcryptjs');
  const existing = await Admin.findOne({ email: cfg.ADMIN_EMAIL.toLowerCase() });
  if (!existing) {
    const hash = await bcrypt.hash(cfg.ADMIN_PASSWORD, 10);
    await Admin.create({ email: cfg.ADMIN_EMAIL.toLowerCase(), password_hash: hash, name: 'Admin' });
    console.log(`  Admin user   : created (${cfg.ADMIN_EMAIL})`);
  } else {
    console.log(`  Admin user   : ✓ exists (${cfg.ADMIN_EMAIL})`);
  }
  console.log('──────────────────────────────────────────────');

  app.listen(cfg.PORT, () => {
    console.log(`  Backend API  : http://localhost:${cfg.PORT}`);
    console.log(`  Frontend     : ${cfg.FRONTEND_URL}`);
    console.log('══════════════════════════════════════════════\n');
  });
}

startup().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
