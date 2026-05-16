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

// Połączenie z bazą PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Inicjalizacja tabeli przy starcie
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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Baza danych gotowa');
  } catch (e) {
    console.error('Błąd inicjalizacji bazy:', e.message);
  }
}
initDB();

// Pobierz wszystkie faktury
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC');
    const invoices = result.rows.map(r => ({
      id: r.id,
      company: r.company,
      type: r.type,
      num: r.num,
      date: r.date,
      contractor: r.contractor,
      buyer: r.buyer,
      description: r.description,
      brutto: parseFloat(r.brutto),
      bruttoOrig: parseFloat(r.brutto_orig) || null,
      vatRate: r.vat_rate,
      currency: r.currency,
      nbpRate: parseFloat(r.nbp_rate) || null,
      nbpDate: r.nbp_date,
      nbpTable: r.nbp_table,
      nbpInfo: r.nbp_info,
      confidence: r.confidence,
    }));
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Zapisz fakturę
app.post('/api/invoices', async (req, res) => {
  try {
    const i = req.body;
    await pool.query(`
      INSERT INTO invoices (id, company, type, num, date, contractor, buyer, description,
        brutto, brutto_orig, vat_rate, currency, nbp_rate, nbp_date, nbp_table, nbp_info, confidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO NOTHING
    `, [i.id, i.company, i.type, i.num, i.date, i.contractor, i.buyer, i.description,
        i.brutto, i.bruttoOrig, i.vatRate, i.currency, i.nbpRate, i.nbpDate, i.nbpTable, i.nbpInfo, i.confidence]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Usuń fakturę
app.delete('/api/invoices/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy do Anthropic API
app.post('/api/scan', async (req, res) => {
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
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'API error', full: data });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy do NBP
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
