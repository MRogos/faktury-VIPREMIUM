// =====================================================================
//  Parser XML faktury FA(3) -> dane kosztu (pobieranie z KSeF).
//  Regex-based (bez zaleznosci XML), odporny na whitespace/namespace.
//  Port z Premium TMS (fa3-parser.ts).
// =====================================================================

const dec = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dziesietnie) => String.fromCodePoint(parseInt(dziesietnie, 10)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function tag(xml, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i');
  const m = xml.match(re);
  return m ? dec(m[1].trim()) : null;
}

function block(xml, name) {
  return tag(xml, name);
}

function tagAll(xml, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(dec(m[1].trim()));
  return out;
}

const num = (s) => {
  if (!s) return 0;
  const n = Number(String(s).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
};

function parseFA3(xml) {
  const p1 = block(xml, 'Podmiot1') || '';
  const p2 = block(xml, 'Podmiot2') || '';
  const p1Ident = block(p1, 'DaneIdentyfikacyjne') || p1;
  const p2Ident = block(p2, 'DaneIdentyfikacyjne') || p2;
  const p1Adres = block(p1, 'Adres') || '';
  const p2Adres = block(p2, 'Adres') || '';

  const fa = block(xml, 'Fa') || xml;
  const platn = block(fa, 'Platnosc') || '';
  const termin = block(platn, 'TerminPlatnosci') || '';
  const rb = block(platn, 'RachunekBankowy') || '';

  let netto = 0, vat = 0;
  for (let i = 1; i <= 11; i++) {
    netto += num(tag(fa, `P_13_${i}`));
    vat += num(tag(fa, `P_14_${i}`));
  }
  ['6_1', '6_2', '6_3'].forEach((g) => { netto += num(tag(fa, `P_13_${g}`)); });
  const brutto = num(tag(fa, 'P_15'));

  const wiersze = tagAll(fa, 'FaWiersz');
  const pozycje = wiersze.map((w) => ({
    nazwa: tag(w, 'P_7') || '',
    ilosc: num(tag(w, 'P_8B')) || null,
    jednostka: tag(w, 'P_8A') || '',
    cena: num(tag(w, 'P_9A')) || null,
    cenaBrutto: num(tag(w, 'P_9B')) || null,
    netto: num(tag(w, 'P_11')),
    wartoscBrutto: num(tag(w, 'P_11A')) || null,
    stawka: tag(w, 'P_12') || '',
  }));

  // Dodatkowy opis (tu Orlen/Flotex wrzuca szczegoly per karta/pojazd)
  const dodatkowe = tagAll(fa, 'DodatkowyOpis').map((b) => ({
    nr: tag(b, 'NrWiersza'),
    klucz: tag(b, 'Klucz'),
    wartosc: tag(b, 'Wartosc'),
  })).filter((x) => x.klucz || x.wartosc);

  const adresLinie = (a) => [tag(a, 'AdresL1'), tag(a, 'AdresL2')].filter(Boolean).join(', ');
  const kraj = (a) => tag(a, 'KodKraju');

  return {
    numer: tag(fa, 'P_2'),
    dataWystawienia: tag(fa, 'P_1'),
    dataSprzedazy: tag(fa, 'P_6'),
    terminPlatnosci: tag(termin, 'Termin') || tag(fa, 'TerminPlatnosci') || null,
    rachunek: tag(rb, 'NrRB') || null,
    formaPlatnosci: tag(platn, 'FormaPlatnosci') || null,
    waluta: tag(fa, 'KodWaluty') || 'PLN',
    sprzedawcaNip: tag(p1Ident, 'NIP'),
    sprzedawcaNazwa: tag(p1Ident, 'Nazwa') || tag(p1Ident, 'PelnaNazwa'),
    sprzedawcaAdres: adresLinie(p1Adres) || tag(p1Adres, 'AdresL1'),
    sprzedawcaKraj: kraj(p1Adres),
    nabywcaNip: tag(p2Ident, 'NIP'),
    nabywcaNazwa: tag(p2Ident, 'Nazwa') || tag(p2Ident, 'PelnaNazwa'),
    nabywcaAdres: adresLinie(p2Adres) || tag(p2Adres, 'AdresL1'),
    nabywcaKraj: kraj(p2Adres),
    netto,
    vat,
    brutto: brutto || (netto + vat),
    pozycje,
    dodatkowe,
    rodzaj: tag(fa, 'RodzajFaktury'),
  };
}

module.exports = { parseFA3 };
