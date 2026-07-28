const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ksef = require('./ksef');
const { parseFA3 } = require('./fa3-parser');

// NIP-y zaszyte na sztywno per firma (zero pomylek). vt = GB, poza KSeF.
const KSEF_NIP = { pt: '9880307881', et: '9131643401', vr: '8762406696' };

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const APP_PASSWORD = process.env.APP_PASSWORD || 'vipremium2026';
const WORKER_PASSWORD = process.env.WORKER_PASSWORD || 'pracownik2026';

// R2 client
const r2 = process.env.R2_ENDPOINT ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;
const R2_BUCKET = process.env.R2_BUCKET || 'vipremium-faktury';

// Init DB
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id VARCHAR(100) PRIMARY KEY,
        company VARCHAR(10),
        type VARCHAR(10),
        num VARCHAR(200),
        date VARCHAR(20),
        contractor VARCHAR(500),
        buyer VARCHAR(500),
        description TEXT,
        brutto NUMERIC(14,2),
        brutto_orig NUMERIC(14,2),
        vat_rate INTEGER DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'PLN',
        nbp_rate NUMERIC(12,6),
        nbp_date VARCHAR(20),
        nbp_table VARCHAR(100),
        nbp_info TEXT,
        confidence VARCHAR(20),
        paid BOOLEAN DEFAULT FALSE,
        due_date VARCHAR(20),
        note TEXT,
        cost_cat VARCHAR(20) DEFAULT 'other',
        vehicles TEXT DEFAULT '[]',
        vehicle_breakdown TEXT DEFAULT '[]',
        vat_country VARCHAR(5),
        vat_amount NUMERIC(14,4),
        attachment_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Migrations
    const migrations = [
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date VARCHAR(20)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS note TEXT",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS brutto_orig NUMERIC(14,2)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS nbp_rate NUMERIC(12,6)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS nbp_date VARCHAR(20)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS nbp_table VARCHAR(100)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS nbp_info TEXT",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS confidence VARCHAR(20)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer VARCHAR(500)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'PLN'",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_rate INTEGER DEFAULT 0",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cost_cat VARCHAR(20) DEFAULT 'other'",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vehicles TEXT DEFAULT '[]'",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vehicle_breakdown TEXT DEFAULT '[]'",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_country VARCHAR(5)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_amount NUMERIC(14,4)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS attachment_url TEXT",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_date VARCHAR(20)",
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_manual BOOLEAN DEFAULT FALSE",
    ];
    for (const sql of migrations) {
      await pool.query(sql).catch(e => console.log('Migration skip:', e.message));
    }
    // Fleet (pojazdy) - zarzadzane z UI
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fleet (
        plate VARCHAR(20) PRIMARY KEY,
        note VARCHAR(100),
        active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    const DEFAULT_FLEET = ['DW7MP83','DW6RS03','DWLTA36','WPR8462U','WGM9808M','DSWTF32','DSR80719','DSR80682','DSR80874'];
    const fcnt = await pool.query('SELECT COUNT(*)::int AS n FROM fleet');
    if (fcnt.rows[0].n === 0) {
      for (let i = 0; i < DEFAULT_FLEET.length; i++) {
        await pool.query('INSERT INTO fleet(plate,sort_order) VALUES($1,$2) ON CONFLICT DO NOTHING', [DEFAULT_FLEET[i], i]);
      }
      console.log('Fleet seeded with defaults');
    }
    // KSeF: ustawienia per firma (token + srodowisko) i poczekalnia faktur
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ksef_settings (
        company VARCHAR(10) PRIMARY KEY,
        token TEXT,
        env VARCHAR(10) DEFAULT 'test',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ksef_inbox (
        id SERIAL PRIMARY KEY,
        company VARCHAR(10),
        ksef_number VARCHAR(80) UNIQUE,
        invoice_no VARCHAR(200),
        issue_date VARCHAR(20),
        seller_nip VARCHAR(20),
        seller_name VARCHAR(500),
        seller_address VARCHAR(500),
        net_amount NUMERIC(14,2),
        vat_amount NUMERIC(14,2),
        gross_amount NUMERIC(14,2),
        currency VARCHAR(10) DEFAULT 'PLN',
        items_json TEXT,
        xml_raw TEXT,
        status VARCHAR(20) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('DB ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}
initDB();

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token === APP_PASSWORD || token === WORKER_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// AUTH
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) return res.json({ ok: true, role: 'owner' });
  if (password === WORKER_PASSWORD) return res.json({ ok: true, role: 'worker' });
  res.json({ ok: false });
});

// GET invoices
app.get('/api/invoices', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY date DESC, created_at DESC');
    const rows = result.rows.map(r => ({
      id: r.id,
      company: r.company,
      type: r.type,
      num: r.num,
      date: r.date,
      contractor: r.contractor,
      buyer: r.buyer,
      description: r.description,
      brutto: parseFloat(r.brutto) || 0,
      bruttoOrig: r.brutto_orig ? parseFloat(r.brutto_orig) : null,
      vatRate: parseInt(r.vat_rate) || 0,
      currency: r.currency || 'PLN',
      nbpRate: r.nbp_rate ? parseFloat(r.nbp_rate) : null,
      nbpDate: r.nbp_date,
      nbpTable: r.nbp_table,
      nbpInfo: r.nbp_info,
      confidence: r.confidence,
      paid: r.paid || false,
      paidDate: r.paid_date || null,
      dueDate: r.due_date || null,
      note: r.note || null,
      costCat: r.cost_cat || 'other',
      vehicles: JSON.parse(r.vehicles || '[]'),
      vehicleBreakdown: JSON.parse(r.vehicle_breakdown || '[]'),
      vatCountry: r.vat_country || null,
      vatAmount: r.vat_amount ? parseFloat(r.vat_amount) : null,
      vatManual: r.vat_manual || false,
      attachmentUrl: r.attachment_url || null,
    }));
    res.json(rows);
  } catch (e) {
    console.error('GET invoices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST invoice (UPSERT)
app.post('/api/invoices', requireAuth, async (req, res) => {
  try {
    const i = req.body;
    if (!i.id) return res.status(400).json({ error: 'Missing id' });

    await pool.query(`
      INSERT INTO invoices (
        id, company, type, num, date, contractor, buyer, description,
        brutto, brutto_orig, vat_rate, currency, nbp_rate, nbp_date,
        nbp_table, nbp_info, confidence, paid, due_date, note, cost_cat,
        vehicles, vehicle_breakdown, vat_country, vat_amount, paid_date, vat_manual
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27
      )
      ON CONFLICT (id) DO UPDATE SET
        company = EXCLUDED.company,
        type = EXCLUDED.type,
        num = EXCLUDED.num,
        date = EXCLUDED.date,
        contractor = EXCLUDED.contractor,
        buyer = EXCLUDED.buyer,
        description = EXCLUDED.description,
        brutto = EXCLUDED.brutto,
        brutto_orig = EXCLUDED.brutto_orig,
        vat_rate = EXCLUDED.vat_rate,
        currency = EXCLUDED.currency,
        nbp_rate = EXCLUDED.nbp_rate,
        nbp_date = EXCLUDED.nbp_date,
        nbp_table = EXCLUDED.nbp_table,
        nbp_info = EXCLUDED.nbp_info,
        confidence = EXCLUDED.confidence,
        due_date = EXCLUDED.due_date,
        note = EXCLUDED.note,
        cost_cat = EXCLUDED.cost_cat,
        vehicles = EXCLUDED.vehicles,
        vehicle_breakdown = EXCLUDED.vehicle_breakdown,
        vat_country = EXCLUDED.vat_country,
        vat_amount = EXCLUDED.vat_amount,
        paid = EXCLUDED.paid,
        paid_date = EXCLUDED.paid_date,
        vat_manual = EXCLUDED.vat_manual
    `, [
      i.id, i.company || 'vt', i.type || 'buy', i.num || '', i.date || '',
      i.contractor || '', i.buyer || '', i.description || '',
      i.brutto || 0, i.bruttoOrig || null, i.vatRate || 0,
      i.currency || 'PLN', i.nbpRate || null, i.nbpDate || null,
      i.nbpTable || null, i.nbpInfo || null, i.confidence || 'medium',
      i.paid || false, i.dueDate || null, i.note || null,
      i.costCat || 'other', JSON.stringify(i.vehicles || []), JSON.stringify(i.vehicleBreakdown || []),
      i.vatCountry || null, i.vatAmount || null,
      i.paidDate || null, i.vatManual || false
    ]);

    console.log('Saved invoice:', i.id, i.num, i.brutto);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST invoice error:', e.message, e.detail);
    res.status(500).json({ error: e.message });
  }
});

// PATCH paid
app.patch('/api/invoices/:id/paid', requireAuth, async (req, res) => {
  try {
    const { paid } = req.body;
    await pool.query('UPDATE invoices SET paid = $1 WHERE id = $2', [paid, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH note
app.patch('/api/invoices/:id/note', requireAuth, async (req, res) => {
  try {
    const { note } = req.body;
    await pool.query('UPDATE invoices SET note = $1 WHERE id = $2', [note, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH due date
app.patch('/api/invoices/:id/due', requireAuth, async (req, res) => {
  try {
    const { dueDate } = req.body;
    await pool.query('UPDATE invoices SET due_date = $1 WHERE id = $2', [dueDate, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE invoice
app.delete('/api/invoices/:id', requireAuth, async (req, res) => {
  try {
    // Usun attachment jesli jest
    const r = await pool.query('SELECT attachment_url FROM invoices WHERE id = $1', [req.params.id]);
    if (r.rows[0]?.attachment_url && r2) {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: r.rows[0].attachment_url })).catch(() => {});
    }
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST attachment
app.post('/api/invoices/:id/attachment', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!r2) return res.status(500).json({ error: 'R2 not configured' });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });
    const key = `inv/${req.params.id}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key,
      Body: file.buffer, ContentType: file.mimetype
    }));
    await pool.query('UPDATE invoices SET attachment_url = $1 WHERE id = $2', [key, req.params.id]);
    res.json({ ok: true, key });
  } catch (e) {
    console.error('Attachment upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET attachment (presigned URL)
app.get('/api/invoices/:id/attachment', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT attachment_url FROM invoices WHERE id = $1', [req.params.id]);
    const key = r.rows[0]?.attachment_url;
    if (!key) return res.json({ url: null });
    if (!r2) return res.json({ url: null });
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE attachment
app.delete('/api/invoices/:id/attachment', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT attachment_url FROM invoices WHERE id = $1', [req.params.id]);
    const key = r.rows[0]?.attachment_url;
    if (key && r2) await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {});
    await pool.query('UPDATE invoices SET attachment_url = NULL WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SCAN proxy
app.post('/api/scan', requireAuth, async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NBP proxy
app.get('/api/nbp/:currency/:date', async (req, res) => {
  const { currency, date } = req.params;
  const d = new Date(date);
  for (let i = 1; i <= 7; i++) {
    const dd = new Date(d);
    dd.setDate(dd.getDate() - i);
    const ds = dd.toISOString().slice(0, 10);
    try {
      const r = await fetch(`https://api.nbp.pl/api/exchangerates/rates/A/${currency}/${ds}/?format=json`);
      if (r.ok) {
        const data = await r.json();
        return res.json({ rate: data.rates[0].mid, date: data.rates[0].effectiveDate, table: data.rates[0].no });
      }
    } catch (e) {}
  }
  res.status(404).json({ error: 'Kurs NBP nie znaleziony' });
});

// Export CSV
app.get('/api/export/csv', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY date DESC');
    const headers = ['ID','Firma','Typ','Numer','Data','Kontrahent','Opis','Brutto PLN','Brutto orig','Waluta','VAT%','Kurs NBP','VAT kraj','Termin','Notatka','Oplacona'];
    const csv = [headers.join(';')].concat(result.rows.map(r => [
      r.id, r.company, r.type, (r.num||'').replace(/;/g,','),
      r.date||'', (r.contractor||'').replace(/;/g,','),
      (r.description||'').replace(/;/g,','),
      r.brutto, r.brutto_orig||'', r.currency||'PLN',
      r.vat_rate||0, r.nbp_rate||'', r.vat_country||'',
      r.due_date||'', (r.note||'').replace(/;/g,','),
      r.paid?'TAK':'NIE'
    ].join(';'))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="faktury.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FLEET (pojazdy)
app.get('/api/fleet', requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT plate, note FROM fleet WHERE active = TRUE ORDER BY sort_order, plate");
    res.json(r.rows.map(x => ({ plate: x.plate, note: x.note })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fleet', requireAuth, async (req, res) => {
  try {
    const plate = (req.body.plate || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!plate) return res.status(400).json({ error: 'Brak numeru rejestracyjnego' });
    const note = (req.body.note || '').trim() || null;
    const mx = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM fleet');
    await pool.query(
      "INSERT INTO fleet(plate,note,active,sort_order) VALUES($1,$2,TRUE,$3) ON CONFLICT(plate) DO UPDATE SET active=TRUE, note=EXCLUDED.note",
      [plate, note, mx.rows[0].n]
    );
    res.json({ ok: true, plate: plate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fleet/:plate', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE fleet SET active = FALSE WHERE plate = $1', [req.params.plate]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= KSeF =================
async function ksefCfgFor(company) {
  const nip = KSEF_NIP[company];
  if (!nip) throw new Error('Firma spoza KSeF (tylko PT&L / ET&VG / VMR)');
  const r = await pool.query('SELECT token, env FROM ksef_settings WHERE company=$1', [company]);
  const row = r.rows[0] || {};
  return ksef.buildCfg({ nip, token: row.token || '', env: row.env || 'test' });
}

// Status ustawien per firma (token NIGDY nie wraca do klienta)
app.get('/api/ksef/settings', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT company, env, token FROM ksef_settings');
    const map = {};
    r.rows.forEach(x => { map[x.company] = { env: x.env, hasToken: !!x.token }; });
    const out = Object.keys(KSEF_NIP).map(c => ({
      company: c, nip: KSEF_NIP[c],
      env: (map[c] && map[c].env) || 'test',
      hasToken: !!(map[c] && map[c].hasToken),
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Zapis tokenu / srodowiska. token pusty => zostaje poprzedni (zmiana samego env).
app.post('/api/ksef/settings', requireAuth, async (req, res) => {
  try {
    const company = req.body.company;
    if (!KSEF_NIP[company]) return res.status(400).json({ error: 'Firma spoza KSeF' });
    const env = ['test', 'demo', 'prod'].includes(req.body.env) ? req.body.env : 'test';
    const token = (req.body.token || '').trim();
    if (token) {
      await pool.query(
        `INSERT INTO ksef_settings (company, token, env, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (company) DO UPDATE SET token=EXCLUDED.token, env=EXCLUDED.env, updated_at=NOW()`,
        [company, token, env]
      );
    } else {
      await pool.query(
        `INSERT INTO ksef_settings (company, env, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (company) DO UPDATE SET env=EXCLUDED.env, updated_at=NOW()`,
        [company, env]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test polaczenia dla firmy
app.post('/api/ksef/test', requireAuth, async (req, res) => {
  try {
    const cfg = await ksefCfgFor(req.body.company);
    if (!ksef.ready(cfg)) return res.status(400).json({ error: 'Brak tokenu dla tej firmy' });
    const r = await ksef.ksefTest(cfg);
    res.json({ ok: true, env: r.env, nip: r.nip });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Pobranie faktur zakupowych paczka (eksport -> polling -> deszyfracja -> poczekalnia)
app.post('/api/ksef/pull', requireAuth, async (req, res) => {
  const company = req.body.company;
  const days = Math.min(Math.max(Number(req.body.days) || 30, 1), 730);
  if (!KSEF_NIP[company]) return res.status(400).json({ error: 'Firma spoza KSeF' });
  let cfg;
  try { cfg = await ksefCfgFor(company); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!ksef.ready(cfg)) return res.status(400).json({ error: 'Firma nie ma skonfigurowanego tokenu KSeF' });

  const teraz = new Date();
  const od = new Date(teraz.getTime() - days * 86400000);
  let nowe = 0, duplikaty = 0, bledy = 0; const errors = [];
  try {
    const zlecenie = await ksef.ksefZlecEksport(cfg, { dateFrom: od.toISOString(), dateTo: teraz.toISOString() });
    let czesci = []; let ostatniOpis = '';
    for (let proba = 0; proba < 25; proba++) {
      await new Promise(r => setTimeout(r, 3000));
      const st = await ksef.ksefStatusEksportu(cfg, zlecenie.referenceNumber);
      ostatniOpis = st.kodStatusu + ' ' + st.opis;
      if (st.gotowe) { czesci = st.czesci; break; }
      if (st.kodStatusu >= 400) return res.status(502).json({ error: 'KSeF eksport nieudany: ' + ostatniOpis });
    }
    if (!czesci.length) return res.status(504).json({ error: 'Eksport nie zakonczyl sie w oczekiwanym czasie (status: ' + ostatniOpis + '). Sprobuj ponownie za chwile.' });

    const faktury = await ksef.ksefPobierzPaczke(zlecenie, czesci);
    for (const f of faktury) {
      try {
        const p = parseFA3(f.xml);
        const numerKsef = f.nazwa.replace(/\.xml$/i, '').split('/').pop() || f.nazwa;
        try {
          await pool.query(
            `INSERT INTO ksef_inbox (company,ksef_number,invoice_no,issue_date,seller_nip,seller_name,seller_address,net_amount,vat_amount,gross_amount,currency,items_json,xml_raw,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new')`,
            [company, numerKsef, p.numer, p.dataWystawienia, p.sprzedawcaNip, p.sprzedawcaNazwa, p.sprzedawcaAdres,
             p.netto, p.vat, p.brutto, p.waluta, JSON.stringify(p.pozycje || []), f.xml]
          );
          nowe++;
        } catch (insErr) {
          if (insErr.code === '23505') duplikaty++;
          else { bledy++; errors.push(numerKsef + ': ' + insErr.message); }
        }
      } catch (e) { bledy++; errors.push(f.nazwa + ': ' + (e.message || 'blad parsowania')); }
    }
    res.json({ ok: true, wPaczce: faktury.length, nowe, duplikaty, bledy, errors: errors.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: e.message || 'Blad eksportu z KSeF' }); }
});

// Poczekalnia — faktury pobrane, jeszcze nie zaksiegowane
app.get('/api/ksef/inbox', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, company, ksef_number, invoice_no, issue_date, seller_nip, seller_name, seller_address,
              net_amount, vat_amount, gross_amount, currency, items_json
       FROM ksef_inbox WHERE status='new' ORDER BY issue_date DESC, id DESC`
    );
    res.json(r.rows.map(x => ({
      id: x.id, company: x.company, ksefNumber: x.ksef_number, num: x.invoice_no, date: x.issue_date,
      sellerNip: x.seller_nip, seller: x.seller_name, sellerAddr: x.seller_address,
      netto: x.net_amount != null ? parseFloat(x.net_amount) : 0,
      vat: x.vat_amount != null ? parseFloat(x.vat_amount) : 0,
      brutto: x.gross_amount != null ? parseFloat(x.gross_amount) : 0,
      currency: x.currency || 'PLN',
      items: (() => { try { return JSON.parse(x.items_json || '[]'); } catch (e) { return []; } })(),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Zaksieguj pozycje z poczekalni -> faktura kosztowa (z przypisanym autem + kategoria)
app.post('/api/ksef/inbox/:id/book', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const costCat = req.body.costCat || 'other';
    const vehicles = Array.isArray(req.body.vehicles) ? req.body.vehicles : [];
    const r = await pool.query('SELECT * FROM ksef_inbox WHERE id=$1', [id]);
    const it = r.rows[0];
    if (!it) return res.status(404).json({ error: 'Nie znaleziono w poczekalni' });
    if (it.status === 'booked') return res.status(400).json({ error: 'Juz zaksiegowana' });
    const net = Number(it.net_amount) || 0, vat = Number(it.vat_amount) || 0, gross = Number(it.gross_amount) || 0;
    const vatRate = net > 0 ? Math.round(vat / net * 100) : 23;
    const invId = 'ksef' + String(it.ksef_number || id).replace(/[^a-zA-Z0-9]/g, '');
    await pool.query(
      `INSERT INTO invoices (id,company,type,num,date,contractor,brutto,vat_rate,currency,cost_cat,vehicles,vat_amount,vat_manual,note,confidence)
       VALUES ($1,$2,'buy',$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12,'ksef')
       ON CONFLICT (id) DO NOTHING`,
      [invId, it.company, it.invoice_no || '', it.issue_date || '', it.seller_name || '', gross, vatRate,
       it.currency || 'PLN', costCat, JSON.stringify(vehicles), vat, 'KSeF: ' + it.ksef_number]
    );
    await pool.query("UPDATE ksef_inbox SET status='booked' WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Odrzuc pozycje z poczekalni (nie ksiegujemy)
app.delete('/api/ksef/inbox/:id', requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE ksef_inbox SET status='discarded' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
