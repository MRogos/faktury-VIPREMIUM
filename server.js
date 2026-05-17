const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_PASSWORD || 'vipremium2026';
const WORKER_PASSWORD = process.env.WORKER_PASSWORD || 'pracownik2026';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id VARCHAR(50) PRIMARY KEY,
        company VARCHAR(10),
        type VARCHAR(10),
        num VARCHAR(100),
        date VARCHAR(20),
        contractor VARCHAR(255),
        buyer VARCHAR(255),
        description TEXT,
        brutto NUMERIC(12,2),
        brutto_orig NUMERIC(12,2),
        vat_rate INTEGER,
        currency VARCHAR(10),
        nbp_rate NUMERIC(10,4),
        nbp_date VARCHAR(20),
        nbp_table VARCHAR(50),
        nbp_info TEXT,
        confidence VARCHAR(20),
        paid BOOLEAN DEFAULT FALSE,
        due_date VARCHAR(20),
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Add new columns if they don't exist (migration)
    await pool.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date VARCHAR(20)").catch(()=>{});
    await pool.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS note TEXT").catch(()=>{});
    console.log('Baza danych gotowa');
  } catch (e) {
    console.error('Błąd inicjalizacji bazy:', e.message);
  }
}
initDB();

// Auth middleware
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Brak autoryzacji' });
  }
  next();
}

// Login
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    res.json({ ok: true, role: 'owner' });
  } else if (password === WORKER_PASSWORD) {
    res.json({ ok: true, role: 'worker' });
  } else {
    res.json({ ok: false });
  }
});

// Pobierz wszystkie faktury
app.get('/api/invoices', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC');
    const invoices = result.rows.map(r => ({
      id: r.id, company: r.company, type: r.type, num: r.num, date: r.date,
      contractor: r.contractor, buyer: r.buyer, description: r.description,
      brutto: parseFloat(r.brutto), bruttoOrig: parseFloat(r.brutto_orig) || null,
      vatRate: r.vat_rate, currency: r.currency,
      nbpRate: parseFloat(r.nbp_rate) || null, nbpDate: r.nbp_date,
      nbpTable: r.nbp_table, nbpInfo: r.nbp_info, confidence: r.confidence,
    }));
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Zapisz fakturę
app.post('/api/invoices', requireAuth, async (req, res) => {
  try {
    const i = req.body;
    await pool.query(`
      INSERT INTO invoices (id, company, type, num, date, contractor, buyer, description,
        brutto, brutto_orig, vat_rate, currency, nbp_rate, nbp_date, nbp_table, nbp_info, confidence, due_date, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (id) DO UPDATE SET note=EXCLUDED.note, due_date=EXCLUDED.due_date, paid=EXCLUDED.paid
    `, [i.id, i.company, i.type, i.num, i.date, i.contractor, i.buyer, i.description,
        i.brutto, i.bruttoOrig, i.vatRate, i.currency, i.nbpRate, i.nbpDate, i.nbpTable, i.nbpInfo, i.confidence,
        i.dueDate||null, i.note||null]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Zaktualizuj notatkę
app.patch('/api/invoices/:id/note', requireAuth, async (req, res) => {
  try {
    const { note } = req.body;
    await pool.query('UPDATE invoices SET note = $1 WHERE id = $2', [note, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Zaktualizuj termin płatności
app.patch('/api/invoices/:id/due', requireAuth, async (req, res) => {
  try {
    const { dueDate } = req.body;
    await pool.query('UPDATE invoices SET due_date = $1 WHERE id = $2', [dueDate, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Oznacz fakturę jako opłaconą
app.patch('/api/invoices/:id/paid', requireAuth, async (req, res) => {
  try {
    const { paid } = req.body;
    await pool.query('UPDATE invoices SET paid = $1 WHERE id = $2', [paid, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Usuń fakturę
app.delete('/api/invoices/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy Anthropic
app.post('/api/scan', requireAuth, async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message, full: data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export faktur do CSV
app.get('/api/export/csv', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY date DESC');
    const rows = result.rows;
    const headers = ['ID','Firma','Typ','Numer','Data','Kontrahent','Nabywca','Opis','Brutto PLN','Brutto oryg','Stawka VAT','Waluta','Kurs NBP','Data NBP','Termin platnosci','Notatka','Oplacona'];
    const csv = [headers.join(';')].concat(rows.map(r => [
      r.id, r.company, r.type, r.num||'', r.date||'', 
      (r.contractor||'').replace(/;/g,','), (r.buyer||'').replace(/;/g,','),
      (r.description||'').replace(/;/g,','),
      r.brutto, r.brutto_orig||'', r.vat_rate||0, r.currency||'PLN',
      r.nbp_rate||'', r.nbp_date||'', r.due_date||'',
      (r.note||'').replace(/;/g,',').replace(/\n/g,' '),
      r.paid?'TAK':'NIE'
    ].join(';'))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="faktury-vipremium.csv"');
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy NBP
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
    } catch {}
  }
  res.status(404).json({ error: 'Nie znaleziono kursu NBP' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vipremium server running on port ${PORT}`));
