// =====================================================================
//  Klient KSeF 2.0 (API v2) dla FAKTURY VIPREMIUM (Express / CommonJS).
//  Port sprawdzonego klienta z Premium TMS — TYLKO czesc pobierajaca
//  (autoryzacja tokenem + eksport paczki faktur zakupowych).
//  Konfiguracja (nip/token/env) przekazywana jako argument (dane firmy).
//  Cache tokenu PER NIP.
// =====================================================================
const crypto = require('crypto');

const ENVS = {
  test: 'https://api-test.ksef.mf.gov.pl/api/v2',
  demo: 'https://api-demo.ksef.mf.gov.pl/api/v2',
  prod: 'https://api.ksef.mf.gov.pl/api/v2',
};

function buildCfg(input) {
  const env = (input.env || 'test').toLowerCase();
  const base = ENVS[env];
  if (!base) throw new Error(`Zla wartosc env="${env}" (dozwolone: test, demo, prod)`);
  const nip = (input.nip || '').replace(/[^0-9]/g, '');
  const token = input.token || '';
  return { env, base, nip, token };
}

function ready(cfg) {
  return !!(cfg.base && cfg.nip && cfg.token);
}

function ksefErrMsg(body, statusText) {
  if (body && typeof body === 'object') {
    const ex = body.exception || body.Exception;
    const list = ex && (ex.exceptionDetailList || ex.ExceptionDetailList);
    if (Array.isArray(list) && list.length) {
      return list.map((d) => {
        const code = d.exceptionCode != null ? d.exceptionCode : d.ExceptionCode;
        const desc = d.exceptionDescription || d.ExceptionDescription || '';
        const det = d.details || d.Details;
        const detStr = Array.isArray(det) && det.length ? ' — ' + det.join('; ') : '';
        return `${code != null ? '[' + code + '] ' : ''}${desc}${detStr}`;
      }).join(' | ');
    }
    if (body.message || body.title || body.detail) return body.message || body.title || body.detail;
    if (body.errors) { try { return JSON.stringify(body.errors).slice(0, 400); } catch (e) {} }
    try { return JSON.stringify(body).slice(0, 400); } catch (e) {}
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 400);
  return statusText || '';
}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) {
    const e = new Error(`KSeF ${res.status}: ${ksefErrMsg(body, res.statusText)}`);
    e.status = res.status; e.body = body;
    throw e;
  }
  return body;
}

async function getChallenge(base, nip) {
  return jfetch(`${base}/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contextIdentifier: { type: 'Nip', value: nip } }),
  });
}

async function getPublicKey(base, usage) {
  const body = await jfetch(`${base}/security/public-key-certificates`, { method: 'GET' });
  const list = Array.isArray(body) ? body : (body.certificates || body.publicKeyCertificates || []);
  if (!list.length) throw new Error('KSeF: brak klucza publicznego w /security/public-key-certificates');
  const hasUsage = (c, u) => Array.isArray(c.usage) ? c.usage.includes(u) : (c.usage === u);
  const now = Date.now();
  let cand = usage ? list.filter((c) => c && typeof c === 'object' && hasUsage(c, usage)) : list.slice();
  if (!cand.length) cand = list.slice();
  const ok = cand.filter((c) => {
    const vf = c && c.validFrom ? Date.parse(c.validFrom) : -Infinity;
    const vt = c && c.validTo ? Date.parse(c.validTo) : Infinity;
    return vf <= now && now <= vt;
  });
  const pool = ok.length ? ok : cand;
  pool.sort((a, b) => (Date.parse((b && b.validFrom) || 0) || 0) - (Date.parse((a && a.validFrom) || 0) || 0));
  const chosen = pool[0];
  const raw = typeof chosen === 'string' ? chosen : (chosen.certificate || chosen.publicKey || chosen.value || chosen.certificatePem);
  if (!raw) throw new Error('KSeF: nieznany format klucza publicznego');
  const tryKey = (input) => {
    if (/-----BEGIN CERTIFICATE-----/.test(input)) return new crypto.X509Certificate(input).publicKey;
    if (/-----BEGIN (PUBLIC|RSA PUBLIC) KEY-----/.test(input)) return crypto.createPublicKey(input);
    const der = Buffer.from(input.replace(/\s+/g, ''), 'base64');
    try { return new crypto.X509Certificate(der).publicKey; }
    catch (e) { return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  };
  return tryKey(raw);
}

function encryptToken(token, timestamp, pubKey) {
  let millis;
  if (typeof timestamp === 'number') millis = timestamp;
  else if (/^\d+$/.test(String(timestamp).trim())) millis = Number(String(timestamp).trim());
  else millis = Date.parse(timestamp);
  const plain = Buffer.from(`${token}|${millis}`, 'utf8');
  const enc = crypto.publicEncrypt(
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    plain
  );
  return enc.toString('base64');
}

async function submitKsefToken(base, args) {
  const body = await jfetch(`${base}/auth/ksef-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge: args.challenge,
      contextIdentifier: { type: 'Nip', value: args.nip },
      encryptedToken: args.encryptedToken,
      authorizationPolicy: null,
    }),
  });
  const authToken = pickToken(body.authenticationToken);
  return { referenceNumber: body.referenceNumber, authToken };
}

async function waitAuth(base, referenceNumber, authToken, opts = {}) {
  const tries = opts.tries || 15;
  const delayMs = opts.delayMs || 1500;
  for (let i = 0; i < tries; i++) {
    const body = await jfetch(`${base}/auth/${referenceNumber}`, {
      method: 'GET', headers: { authorization: `Bearer ${authToken}` },
    });
    const code = body.status && body.status.code;
    if (code === 200) return body;
    if (code >= 400) throw new Error(`KSeF auth nieudane: ${(body.status && body.status.description) || code}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('KSeF: przekroczono czas oczekiwania na uwierzytelnienie');
}

async function redeem(base, authToken) {
  const body = await jfetch(`${base}/auth/token/redeem`, {
    method: 'POST', headers: { authorization: `Bearer ${authToken}` },
  });
  return { accessToken: pickToken(body.accessToken), refreshToken: pickToken(body.refreshToken) };
}

function pickToken(t) {
  if (!t) return null;
  return typeof t === 'string' ? t : (t.token || t.value || null);
}

// -------- cache tokenu PER NIP --------
const _cache = new Map();

async function ksefAuth(cfg, opts = {}) {
  const force = !!opts.force;
  if (!cfg.nip) throw new Error('Brak NIP firmy');
  if (!cfg.token) throw new Error('Brak tokenu KSeF firmy');
  const cacheKey = `${cfg.env}:${cfg.nip}`;
  const cached = _cache.get(cacheKey);
  if (!force && cached && Date.now() < cached.exp - 30000) return cached.token;

  const ch = await getChallenge(cfg.base, cfg.nip);
  const pub = await getPublicKey(cfg.base, 'KsefTokenEncryption');
  const encryptedToken = encryptToken(cfg.token, ch.timestamp, pub);
  const { referenceNumber, authToken } = await submitKsefToken(cfg.base, { challenge: ch.challenge, nip: cfg.nip, encryptedToken });
  await waitAuth(cfg.base, referenceNumber, authToken);
  const { accessToken } = await redeem(cfg.base, authToken);
  if (!accessToken) throw new Error('KSeF: nie udalo sie pobrac accessToken');
  _cache.set(cacheKey, { token: accessToken, exp: Date.now() + 8 * 60 * 1000 });
  return accessToken;
}

async function ksefTest(cfg) {
  await ksefAuth(cfg, { force: true });
  return { ok: true, env: cfg.env, nip: cfg.nip, base: cfg.base };
}

// -------- szyfrowanie klucza symetrycznego (do eksportu paczki) --------
async function getEncryption(base) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const pub = await getPublicKey(base, 'SymmetricKeyEncryption');
  const encryptedSymmetricKey = crypto.publicEncrypt(
    { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  ).toString('base64');
  return { aesKey, iv, encryptedSymmetricKey, ivB64: iv.toString('base64') };
}

function aesDecrypt(cipherBuf, key, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(cipherBuf), d.final()]);
}

// Zleca eksport faktur zakupowych (subject2 = nabywca = nasza firma).
async function ksefZlecEksport(cfg, opts) {
  const token = await ksefAuth(cfg);
  const enc = await getEncryption(cfg.base);
  const body = {
    encryption: {
      encryptedSymmetricKey: enc.encryptedSymmetricKey,
      initializationVector: enc.ivB64,
    },
    filters: {
      subjectType: 'subject2',
      dateRange: { from: opts.dateFrom, to: opts.dateTo, dateType: 'issue' },
    },
  };
  const res = await jfetch(`${cfg.base}/invoices/exports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ref = (res && (res.operationReferenceNumber || res.referenceNumber || res.reference));
  if (!ref) throw new Error('KSeF eksport: brak numeru referencyjnego. Odpowiedz: ' + JSON.stringify(res).slice(0, 400));
  return { referenceNumber: ref, aesKeyB64: enc.aesKey.toString('base64'), ivB64: enc.ivB64 };
}

async function ksefStatusEksportu(cfg, referenceNumber) {
  const token = await ksefAuth(cfg);
  const res = await jfetch(`${cfg.base}/invoices/exports/${encodeURIComponent(referenceNumber)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const st = res && res.status || {};
  const kodStatusu = Number(st.code != null ? st.code : (res && res.statusCode) || 0);
  const opis = st.description || (res && res.statusDescription) || '';
  const pkg = (res && (res.package || res.invoicePackage)) || {};
  const listaCzesci = pkg.parts || pkg.invoicePackageParts || (res && res.parts) || [];
  const czesci = (Array.isArray(listaCzesci) ? listaCzesci : [])
    .map((p) => (p && (p.url || p.downloadUrl || p.uri)) || (typeof p === 'string' ? p : null))
    .filter(Boolean);
  const gotowe = kodStatusu === 200 || czesci.length > 0;
  return { gotowe, kodStatusu, opis, czesci, surowe: res };
}

// Pobiera czesci paczki, odszyfrowuje AES i wyciaga pliki XML z ZIP-a.
async function ksefPobierzPaczke(zlecenie, czesci) {
  const AdmZip = require('adm-zip');
  const key = Buffer.from(zlecenie.aesKeyB64, 'base64');
  const iv = Buffer.from(zlecenie.ivB64, 'base64');
  const wynik = [];
  for (const url of czesci) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`KSeF pobranie paczki ${res.status}: ${res.statusText}`);
    const zaszyfrowane = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(aesDecrypt(zaszyfrowane, key, iv));
    for (const wpis of zip.getEntries()) {
      if (wpis.isDirectory) continue;
      const nazwa = wpis.entryName;
      if (!/\.xml$/i.test(nazwa)) continue;
      wynik.push({ nazwa, xml: wpis.getData().toString('utf8') });
    }
  }
  return wynik;
}

module.exports = {
  ENVS, buildCfg, ready, ksefAuth, ksefTest,
  ksefZlecEksport, ksefStatusEksportu, ksefPobierzPaczke,
};
