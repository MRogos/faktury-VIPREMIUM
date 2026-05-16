const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const API_KEY = process.env.ANTHROPIC_API_KEY;

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
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
