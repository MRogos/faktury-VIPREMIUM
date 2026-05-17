const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// No cache for API
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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Migrations - add all missing columns
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
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vehicle_breakdown TEXT DEFAULT '[]'"
    ];
    for (const sql of migrations) {
      await pool.query(sql).catch(e => console.log('Migration skip:', e.message));
    }
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
      dueDate: r.due_date || null,
      note: r.note || null,
      costCat: r.cost_cat || 'other',
      vehicles: JSON.parse(r.vehicles || '[]'),
      vehicleBreakdown: JSON.parse(r.vehicle_breakdown || '[]'),
    }));
    res.json(rows);
  } catch (e) {
    console.error('GET invoices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST invoice
app.post('/api/invoices', requireAuth, async (req, res) => {
  try {
    const i = req.body;
    if (!i.id) return res.status(400).json({ error: 'Missing id' });
    
    await pool.query(`
      INSERT INTO invoices (
        id, company, type, num, date, contractor, buyer, description,
        brutto, brutto_orig, vat_rate, currency, nbp_rate, nbp_date, 
        nbp_table, nbp_info, confidence, paid, due_date, note, cost_cat, vehicles, vehicle_breakdown
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23
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
        vehicle_breakdown = EXCLUDED.vehicle_breakdown
    `, [
      i.id, i.company || 'vt', i.type || 'buy', i.num || '', i.date || '',
      i.contractor || '', i.buyer || '', i.description || '',
      i.brutto || 0, i.bruttoOrig || null, i.vatRate || 0,
      i.currency || 'PLN', i.nbpRate || null, i.nbpDate || null,
      i.nbpTable || null, i.nbpInfo || null, i.confidence || 'medium',
      i.paid || false, i.dueDate || null, i.note || null,
      i.costCat || 'other', JSON.stringify(i.vehicles || []), JSON.stringify(i.vehicleBreakdown || [])
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
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
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
        return res.json({
          rate: data.rates[0].mid,
          date: data.rates[0].effectiveDate,
          table: data.rates[0].no
        });
      }
    } catch (e) {}
  }
  res.status(404).json({ error: 'Kurs NBP nie znaleziony' });
});

// Export CSV
app.get('/api/export/csv', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY date DESC');
    const headers = ['ID','Firma','Typ','Numer','Data','Kontrahent','Opis','Brutto PLN','Brutto orig','Waluta','VAT%','Kurs NBP','Termin','Notatka','Oplacona'];
    const csv = [headers.join(';')].concat(result.rows.map(r => [
      r.id, r.company, r.type, (r.num||'').replace(/;/g,','),
      r.date||'', (r.contractor||'').replace(/;/g,','),
      (r.description||'').replace(/;/g,','),
      r.brutto, r.brutto_orig||'', r.currency||'PLN',
      r.vat_rate||0, r.nbp_rate||'',
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
