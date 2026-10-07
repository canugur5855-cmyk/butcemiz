import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EXPENSE_CATEGORIES = ['Market', 'Kira', 'Faturalar', 'Ulaşım', 'Yemek / Kafe', 'Sağlık', 'Giyim', 'Eğitim',
  'Eğlence', 'Ev eşyası', 'Kredi / Taksit', 'Sigorta', 'Hediye', 'Bakım / Kişisel', 'Diğer'];
const INCOME_CATEGORIES = ['Maaş', 'Prim / İkramiye', 'Ek iş', 'Kira geliri', 'Yatırım getirisi', 'Diğer'];
const ASSET_TYPES = ['Altın', 'Döviz', 'Gümüş', 'Hisse senedi', 'Yatırım fonu', 'Mevduat / Vadeli', 'Kripto', 'BES', 'Gayrimenkul', 'Diğer'];
// Fiyatı her gün güncellenen birimler (kodlar public.rates tablosundaki kodlar).
const PRICED_UNITS = {
  'Altın': [['GRA', 'Gram altın', 'gr'], ['CEYREKALTIN', 'Çeyrek altın', 'adet'], ['YARIMALTIN', 'Yarım altın', 'adet'],
    ['TAMALTIN', 'Tam altın', 'adet'], ['CUMHURIYETALTINI', 'Cumhuriyet altını', 'adet'], ['ATAALTIN', 'Ata altın', 'adet'],
    ['YIA', '22 ayar bilezik', 'gr'], ['18AYARALTIN', '18 ayar altın', 'gr'], ['14AYARALTIN', '14 ayar altın', 'gr'],
    ['HAS', 'Has altın', 'gr']],
  'Döviz': [['USD', 'Dolar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'Sterlin', '£'], ['CHF', 'İsviçre frangı', 'CHF']],
  'Gümüş': [['GUMUS', 'Gram gümüş', 'gr']],
};
const UNITS = Object.fromEntries(Object.values(PRICED_UNITS).flat().map(([code, name, unit]) => [code, { name, unit }]));

const state = {
  user: null,
  profiles: {},          // id -> display_name
  transactions: [],
  investments: [],
  withdrawals: [],       // yatırımdan çekişler (bozdurma)
  rates: {},             // kod -> { buying, selling, updated_at }
  shopping: [],
  expected: [],
  month: startOfMonth(new Date()),
  tab: 'summary',
  txFilter: 'all',
  editingTx: null,
  editingInv: null,
  editingWd: null,
  wdInv: null,           // çekiş formunun ait olduğu yatırım
  invAmountTouched: false,  // tutar elle girildiyse kurdan otomatik doldurma durur
  editingExp: null,
  receivingExp: null,  // "Geldi" denince açılan gelir formu kaydedilince bu beklenen gelir kapanır
  expMode: 'single',
  expFilter: 'pending',
  txKind: 'expense',
  channel: null,
};

// ---------- yardımcılar ----------
const $ = (sel) => document.querySelector(sel);
const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });
const fmt = (n) => money.format(n || 0);
const monthFmt = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const shortMonthFmt = new Intl.DateTimeFormat('tr-TR', { month: 'short' });
const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });
const fullDayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const stampFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const qtyFmt = (n) => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 4 });

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayISO() { return toISO(new Date()); }
// Ay ekler; gün o ayda yoksa ayın son gününe düşer (31 Ocak + 1 ay → 28/29 Şubat).
function addMonthsISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate();
  return toISO(new Date(y, m - 1 + n, Math.min(d, last)));
}
function parseDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function nameOf(id) { return state.profiles[id] || '—'; }
function isMe(id) { return id === state.user?.id; }
function sum(arr, f = (x) => x) { return arr.reduce((a, x) => a + Number(f(x)), 0); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function fail(error) {
  console.error(error);
  toast('Hata: ' + (error.message || error));
}

// ---------- kimlik doğrulama ----------
// Kullanıcı adıyla giriş: Supabase arka planda e-posta istediği için kullanıcı adı sabit bir
// sahte alan adına çevrilir (ugur → ugur@butcemiz.local). Bu adrese hiç e-posta gönderilmez.
// Kayıt olma kapalı; hesaplar yönetici tarafından oluşturulur.
function usernameToEmail(username) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', i̇: 'i', ö: 'o', ş: 's', ü: 'u' };
  const clean = username.trim().toLocaleLowerCase('tr').replace(/[çğıöşü]|i̇/g, (c) => map[c]);
  return `${clean}@butcemiz.local`;
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#auth-error').textContent = '';
  $('#auth-submit').disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: usernameToEmail(f.get('username')), password: f.get('password'),
  });
  if (error) {
    $('#auth-error').textContent = error.message.includes('Invalid login') ? 'Kullanıcı adı veya şifre hatalı.' : error.message;
  }
  $('#auth-submit').disabled = false;
});

// Şifre değiştirme
$('#change-password').addEventListener('click', () => {
  $('#pw-form').reset();
  $('#pw-error').textContent = '';
  $('#pw-dialog').showModal();
});

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.password2.value) {
    $('#pw-error').textContent = 'Şifreler aynı değil.';
    return;
  }
  const { error } = await sb.auth.updateUser({ password: f.password.value });
  if (error) {
    $('#pw-error').textContent = error.message.includes('different from the old') ? 'Yeni şifre eskisiyle aynı olamaz.' : error.message;
    return;
  }
  $('#pw-dialog').close();
  toast('Şifren değiştirildi');
});

$('#logout').addEventListener('click', () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user ?? null;
  if (user?.id === state.user?.id) return;
  state.user = user;
  if (user) startApp(); else stopApp();
});

function stopApp() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

async function startApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  await loadAll();
  subscribe();
}

// ---------- veri ----------
async function loadAll() {
  const [p, t, i, s, x, r, w] = await Promise.all([
    sb.from('profiles').select('id, display_name'),
    sb.from('transactions').select('*').order('date', { ascending: false }).order('id', { ascending: false }),
    sb.from('investments').select('*').order('date', { ascending: false }).order('id', { ascending: false }),
    sb.from('shopping_items').select('*').order('checked').order('created_at', { ascending: false }),
    sb.from('expected_incomes').select('*').order('date').order('id'),
    sb.from('rates').select('*'),
    sb.from('withdrawals').select('*').order('date', { ascending: false }).order('id', { ascending: false }),
  ]);
  for (const q of [p, t, i, s, x, r, w]) if (q.error) return fail(q.error);
  state.profiles = Object.fromEntries(p.data.map((x) => [x.id, x.display_name]));
  state.transactions = t.data;
  state.investments = i.data;
  state.shopping = s.data;
  state.expected = x.data;
  state.rates = Object.fromEntries(r.data.map((q) => [q.code, q]));
  state.withdrawals = w.data;
  render();
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadAll, 250);
}

function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = sb.channel('household')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'investments' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shopping_items' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expected_incomes' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawals' }, scheduleReload)
    .subscribe();
}

// Uygulamaya geri dönüldüğünde (telefon kilidi açılınca vb.) verileri tazele.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) loadAll();
});

// ---------- render ----------
function render() {
  $('#month-label').textContent = monthFmt.format(state.month);
  $('#next-month').disabled = state.month >= startOfMonth(new Date());
  renderSummary();
  renderTransactions();
  renderInvestments();
  renderExpected();
  renderShopping();
}

function inMonth(rows, month = state.month) {
  const key = monthKey(month);
  return rows.filter((r) => r.date.startsWith(key));
}

// Ayın birikimi (gelir − gider + yatırımdan çekilen) ve o birikime bağlanan yatırımlar.
function monthSaving(month) {
  return sum(inMonth(state.transactions, month), (t) => (t.kind === 'income' ? t.amount : -t.amount)) + withdrawnIn(month);
}
// Yatırımdan çekilen net para, çekildiği ayın kenarda kalanına eklenir (stopaj eklenmez).
function withdrawnIn(month) {
  return sum(inMonth(state.withdrawals, month), (w) => w.amount);
}
function linkedTo(month, exceptId = null) {
  const key = `${monthKey(month)}-01`;
  return state.investments.filter((x) => x.funded_month === key && x.id !== exceptId);
}
// Kenarda kalan = birikim − bağlanan yatırımlar
function availableIn(month, exceptId = null) {
  return monthSaving(month) - sum(linkedTo(month, exceptId), (x) => x.amount);
}

// Yatırım satırı bozdurulunca değişmez (bağlandığı ayın birikimi geri açılmasın diye);
// kalan miktar ve maliyet çekişlerden hesaplanır.
function withdrawalsOf(x, exceptId = null) {
  return state.withdrawals.filter((w) => w.investment_id === x.id && w.id !== exceptId);
}
function isPriced(x) { return !!x.rate_code && Number(x.quantity) > 0; }
function qtyLeft(x, exceptId = null) {
  return Math.max(0, Number(x.quantity) - sum(withdrawalsOf(x, exceptId), (w) => w.quantity ?? 0));
}
// Fiyatlıda satılan miktar oranında, diğerlerinde çekilen brüt tutar (net + stopaj) kadar düşer.
function costLeft(x, exceptId = null) {
  if (isPriced(x)) return (Number(x.amount) * qtyLeft(x, exceptId)) / Number(x.quantity);
  return Math.max(0, Number(x.amount) - sum(withdrawalsOf(x, exceptId), (w) => Number(w.amount) + Number(w.tax)));
}
function invName(x) {
  return (UNITS[x.rate_code]?.name ?? x.asset_type) + (x.description ? ` · ${x.description}` : '');
}

// Bugünkü değer: bozdurulursa alınacak fiyat (alış), yoksa satış. Fiyatı takip edilmeyen yatırımda null.
function unitPrice(code) {
  const r = state.rates[code];
  return r ? Number(r.buying ?? r.selling) : null;
}
function valueNow(x) {
  const price = x.rate_code && unitPrice(x.rate_code);
  if (!price || x.quantity == null) return null;
  return qtyLeft(x) * price;
}

function renderSummary() {
  const tx = inMonth(state.transactions);
  const inv = inMonth(state.investments);
  const income = sum(tx.filter((t) => t.kind === 'income'), (t) => t.amount);
  const expense = sum(tx.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const net = income - expense;
  const linked = sum(linkedTo(state.month), (x) => x.amount);
  const back = withdrawnIn(state.month);
  const free = net + back - linked;
  const invested = sum(inv, (x) => x.amount);

  $('#sum-income').textContent = fmt(income);
  $('#sum-expense').textContent = fmt(expense);
  $('#sum-net').textContent = fmt(free);
  $('#sum-net').classList.toggle('negative', free < 0);
  const notes = [back > 0 && `${fmt(back)} yatırımdan çekildi`, linked > 0 && `${fmt(linked)} yatırıma bağlandı`].filter(Boolean);
  $('#sum-rate').textContent = notes.length ? [`${fmt(net)} birikti`, ...notes].join(', ')
    : income > 0 ? `Gelirin %${Math.round((net / income) * 100)}'i` : '';
  $('#sum-invest').textContent = fmt(invested);

  // kişi bazında
  const ids = Object.keys(state.profiles).sort((a, b) => (isMe(a) ? -1 : isMe(b) ? 1 : 0));
  $('#person-rows').innerHTML = ids.map((id) => {
    const mine = tx.filter((t) => t.user_id === id);
    const inc = sum(mine.filter((t) => t.kind === 'income'), (t) => t.amount);
    const exp = sum(mine.filter((t) => t.kind === 'expense'), (t) => t.amount);
    return `<tr><th>${esc(nameOf(id))}</th><td>${fmt(inc)}</td><td>${fmt(exp)}</td>
      <td class="${inc - exp < 0 ? 'negative' : ''}">${fmt(inc - exp)}</td></tr>`;
  }).join('');

  // kategori çubukları
  const byCat = {};
  for (const t of tx) if (t.kind === 'expense') byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount);
  $('#category-bars').innerHTML = barRows(byCat, expense, 'expense') || '<p class="empty">Bu ay gider yok.</p>';

  // son 12 ay trendi
  const months = Array.from({ length: 12 }, (_, i) => addMonths(state.month, i - 11));
  const series = months.map((m) => {
    const mt = inMonth(state.transactions, m);
    const inc = sum(mt.filter((t) => t.kind === 'income'), (t) => t.amount);
    const exp = sum(mt.filter((t) => t.kind === 'expense'), (t) => t.amount);
    return { m, inc, exp, net: inc - exp + withdrawnIn(m) - sum(linkedTo(m), (x) => x.amount) };
  });
  const max = Math.max(1, ...series.flatMap((s) => [s.inc, s.exp, Math.abs(s.net)]));
  $('#trend').innerHTML = series.map((s) => `
    <div class="trend-col ${monthKey(s.m) === monthKey(state.month) ? 'current' : ''}"
         title="${monthFmt.format(s.m)} — Gelir ${fmt(s.inc)}, Gider ${fmt(s.exp)}, Net ${fmt(s.net)}">
      <div class="trend-bars">
        <i class="income" style="height:${(s.inc / max) * 100}%"></i>
        <i class="expense" style="height:${(s.exp / max) * 100}%"></i>
        <i class="net ${s.net < 0 ? 'neg' : ''}" style="height:${(Math.abs(s.net) / max) * 100}%"></i>
      </div>
      <span>${shortMonthFmt.format(s.m)}</span>
    </div>`).join('');

  // tüm zamanlar
  const allInc = sum(state.transactions.filter((t) => t.kind === 'income'), (t) => t.amount);
  const allExp = sum(state.transactions.filter((t) => t.kind === 'expense'), (t) => t.amount);
  // yatırımlar bozdurulan kısım düşülerek (kalan maliyetiyle) sayılır
  const allInv = sum(state.investments, costLeft);
  const allLinked = sum(state.investments.filter((x) => x.funded_month), (x) => x.amount);
  const allBack = sum(state.withdrawals, (w) => w.amount);
  $('#all-net').textContent = fmt(allInc - allExp + allBack - allLinked);
  $('#all-invest').textContent = fmt(allInv);
  const allNow = sum(state.investments, (x) => valueNow(x) ?? costLeft(x));
  $('#all-invest-now').textContent = state.investments.some((x) => valueNow(x) != null) ? `Bugün ${fmt(allNow)}` : '';
  const byAsset = {};
  for (const x of state.investments) if (costLeft(x) > 0) byAsset[x.asset_type] = (byAsset[x.asset_type] || 0) + costLeft(x);
  $('#asset-bars').innerHTML = barRows(byAsset, allInv, 'invest');
}

function barRows(obj, total, cls) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
    <div class="bar-row">
      <div class="bar-label"><span>${esc(k)}</span><span>${fmt(v)} <small class="muted">%${Math.round((v / total) * 100)}</small></span></div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(v / total) * 100}%"></div></div>
    </div>`).join('');
}

function filterByOwner(rows) {
  if (state.txFilter === 'me') return rows.filter((r) => isMe(r.user_id));
  if (state.txFilter === 'partner') return rows.filter((r) => !isMe(r.user_id));
  return rows;
}

function ownerBadge(id) {
  return `<span class="badge ${isMe(id) ? 'me' : 'partner'}">${esc(nameOf(id))}</span>`;
}

function renderTransactions() {
  const tx = inMonth(state.transactions);
  const linked = linkedTo(state.month);
  const inc = sum(tx.filter((t) => t.kind === 'income'), (t) => t.amount);
  const exp = sum(tx.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const lnk = sum(linked, (x) => x.amount);
  const wds = inMonth(state.withdrawals);
  const back = sum(wds, (w) => w.amount);
  const free = inc - exp + back - lnk;
  $('#tx-strip').innerHTML = `
    <div><span>Gelir</span><strong class="income">${fmt(inc)}</strong></div>
    <div><span>Gider</span><strong class="expense">${fmt(exp)}</strong></div>
    <div><span>Yatırıma bağlanan</span><strong class="invest">${fmt(lnk)}</strong></div>
    ${back > 0 ? `<div><span>Yatırımdan çekilen</span><strong class="income">${fmt(back)}</strong></div>` : ''}
    <div><span>Kenarda kalan</span><strong class="net ${free < 0 ? 'negative' : ''}">${fmt(free)}</strong></div>`;

  // bu ayın birikimine bağlanan yatırımlar ve yatırımdan çekişler de hareket olarak listelenir
  const invById = Object.fromEntries(state.investments.map((x) => [x.id, x]));
  const rows = filterByOwner([...tx, ...linked.map((x) => ({ ...x, isInv: true })), ...wds.map((w) => ({ ...w, isWd: true }))])
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#tx-empty').classList.toggle('hidden', rows.length > 0);
  $('#tx-list').innerHTML = rows.map((t) => t.isWd ? `
    <li class="item ${isMe(t.user_id) ? 'editable' : ''}" data-id="${t.id}" data-wd>
      <div class="item-main">
        <div class="item-title">↩ ${esc(invName(invById[t.investment_id]))} bozuldu${t.note ? ` <span class="muted">· ${esc(t.note)}</span>` : ''}</div>
        <div class="item-sub">${dayFmt.format(parseDate(t.date))}${Number(t.tax) > 0 ? ` · stopaj ${fmt(t.tax)}` : ''} ${ownerBadge(t.user_id)}</div>
      </div>
      <div class="amount income">+${fmt(t.amount)}</div>
    </li>` : t.isInv ? `
    <li class="item ${isMe(t.user_id) ? 'editable' : ''}" data-id="${t.id}" data-inv>
      <div class="item-main">
        <div class="item-title">📈 ${esc(t.asset_type)}${t.description ? ` <span class="muted">· ${esc(t.description)}</span>` : ''}</div>
        <div class="item-sub">${dayFmt.format(parseDate(t.date))} · yatırıma bağlandı ${ownerBadge(t.user_id)}</div>
      </div>
      <div class="amount invest">−${fmt(t.amount)}</div>
    </li>` : `
    <li class="item ${isMe(t.user_id) ? 'editable' : ''}" data-id="${t.id}">
      <div class="item-main">
        <div class="item-title">${esc(t.category)}${t.note ? ` <span class="muted">· ${esc(t.note)}</span>` : ''}</div>
        <div class="item-sub">${dayFmt.format(parseDate(t.date))} ${ownerBadge(t.user_id)}</div>
      </div>
      <div class="amount ${t.kind}">${t.kind === 'income' ? '+' : '−'}${fmt(t.amount)}</div>
    </li>`).join('');
}

function gainHtml(gain) {
  return `<span class="${gain < 0 ? 'loss' : 'gain'}">${gain < 0 ? '▼' : '▲'}${fmt(Math.abs(gain))}</span>`;
}

function renderPortfolio() {
  // tamamen bozdurulanlar portföyde görünmez
  const priced = state.investments.filter((x) => valueNow(x) != null && qtyLeft(x) > 0);
  const byCode = {};
  for (const x of priced) {
    const g = (byCode[x.rate_code] ??= { qty: 0, cost: 0, value: 0 });
    g.qty += qtyLeft(x);
    g.cost += costLeft(x);
    g.value += valueNow(x);
  }
  const value = sum(priced, valueNow);
  const cost = sum(priced, costLeft);
  $('#pf-value').textContent = fmt(value);
  $('#pf-gain').innerHTML = priced.length ? gainHtml(value - cost) : fmt(0);
  $('#pf-rows').innerHTML = Object.entries(byCode).sort((a, b) => b[1].value - a[1].value).map(([code, g]) => `
    <div class="pf-row">
      <div><strong>${esc(UNITS[code]?.name ?? code)}</strong>
        <small class="muted">${qtyFmt(g.qty)} ${esc(UNITS[code]?.unit ?? '')} · 1 ${esc(UNITS[code]?.unit ?? '')} = ${fmt(state.rates[code].buying ?? state.rates[code].selling)}</small></div>
      <div class="pf-val">${fmt(g.value)}<small>${gainHtml(g.value - g.cost)}</small></div>
    </div>`).join('');

  const untracked = state.investments.filter((x) => valueNow(x) == null && costLeft(x) > 0);
  const stamps = Object.values(state.rates).map((q) => q.updated_at).sort();
  $('#pf-note').innerHTML = [
    priced.length ? '' : 'Altın ve döviz yatırımlarına birim ve miktar girince bugünkü değerleri burada görünür.',
    untracked.length ? `Fiyatı takip edilmeyen ${untracked.length} yatırım (kalan maliyetiyle ${fmt(sum(untracked, costLeft))}) bu hesaba dahil değil.` : '',
    stamps.length ? `Kurlar ${stampFmt.format(new Date(stamps.at(-1)))} itibarıyla, her gün 10:00 ve 17:00'de güncellenir.` : '',
  ].filter(Boolean).join('<br>');
}

// Bozdurulmuş yatırımda kalan kısım: fiyatlıda miktar, diğerlerinde maliyet.
function leftText(x) {
  if (!withdrawalsOf(x).length) return '';
  if (costLeft(x) <= 0) return ' · <span class="late">tamamı bozuldu</span>';
  return isPriced(x) ? ` · kalan ${qtyFmt(qtyLeft(x))} ${esc(UNITS[x.rate_code]?.unit ?? '')}` : ` · kalan ${fmt(costLeft(x))}`;
}

function renderInvestments() {
  renderPortfolio();
  const rows = inMonth(state.investments);
  $('#inv-month-total').textContent = fmt(sum(rows, (x) => x.amount));
  $('#inv-empty').classList.toggle('hidden', rows.length > 0);
  $('#inv-list').innerHTML = rows.map((x) => `
    <li class="item ${isMe(x.user_id) ? 'editable' : ''}" data-id="${x.id}">
      <div class="item-main">
        <div class="item-title">${esc(UNITS[x.rate_code]?.name ?? x.asset_type)}${x.description ? ` <span class="muted">· ${esc(x.description)}</span>` : ''}</div>
        <div class="item-sub">${dayFmt.format(parseDate(x.date))}${x.quantity ? ` · ${qtyFmt(x.quantity)} ${esc(UNITS[x.rate_code]?.unit ?? 'adet/birim')}` : ''}${valueNow(x) != null ? ` · bugün ${fmt(valueNow(x))} ${gainHtml(valueNow(x) - x.amount)}` : ''}${x.funded_month ? ` · ${monthFmt.format(parseDate(x.funded_month))} birikiminden` : ''}${leftText(x)} ${ownerBadge(x.user_id)}</div>
      </div>
      <div class="amount invest">${fmt(x.amount)}</div>
    </li>`).join('');
}

function renderExpected() {
  const today = todayISO();
  const soon = toISO(new Date(Date.now() + 30 * 864e5));
  const pending = state.expected.filter((x) => !x.received);
  const overdue = pending.filter((x) => x.date < today);
  $('#exp-soon').textContent = fmt(sum(pending.filter((x) => x.date <= soon), (x) => x.amount));
  $('#exp-total').textContent = fmt(sum(pending, (x) => x.amount));
  $('#exp-overdue').textContent = overdue.length ? `${overdue.length} ödeme gecikmiş` : '';

  // bekleyenler yakından uzağa, gelenler yeniden eskiye; ay ay gruplanır
  const rows = state.expFilter === 'pending' ? pending : state.expected.filter((x) => x.received).reverse();
  const groups = new Map();
  for (const x of rows) {
    const k = x.date.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  $('#exp-empty').textContent = state.expFilter === 'pending' ? 'Beklenen gelir yok.' : 'Henüz gelen ödeme yok.';
  $('#exp-empty').classList.toggle('hidden', rows.length > 0);
  $('#exp-groups').innerHTML = [...groups].map(([k, xs]) => `
    <div class="group-head"><span>${monthFmt.format(parseDate(`${k}-01`))}</span><span>${fmt(sum(xs, (x) => x.amount))}</span></div>
    <ul class="list">${xs.map((x) => `
      <li class="item ${isMe(x.user_id) ? 'editable' : ''}" data-id="${x.id}">
        <div class="item-main">
          <div class="item-title">${esc(x.source)}${x.plan_id ? ` <span class="muted">· Taksit ${x.installment_no}/${x.installment_count}</span>` : ''}${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ''}</div>
          <div class="item-sub">${dayFmt.format(parseDate(x.date))}${!x.received && x.date < today ? ' <span class="late">gecikti</span>' : ''} ${ownerBadge(x.user_id)}</div>
        </div>
        <div class="amount income">${fmt(x.amount)}</div>
      </li>`).join('')}</ul>`).join('');
}

function renderShopping() {
  const rows = [...state.shopping].sort((a, b) => a.checked - b.checked);
  $('#shop-empty').classList.toggle('hidden', rows.length > 0);
  $('#shop-clear').classList.toggle('hidden', !rows.some((r) => r.checked));
  $('#shop-list').innerHTML = rows.map((s) => `
    <li class="item shop-item ${s.checked ? 'checked' : ''}" data-id="${s.id}">
      <label class="check">
        <input type="checkbox" ${s.checked ? 'checked' : ''}>
        <span class="box"></span>
      </label>
      <div class="item-main">
        <div class="item-title">${esc(s.name)}${s.quantity ? ` <span class="muted">· ${esc(s.quantity)}</span>` : ''}</div>
        <div class="item-sub">${s.checked && s.checked_by ? `${esc(nameOf(s.checked_by))} aldı` : `${esc(nameOf(s.added_by))} ekledi`}</div>
      </div>
      <button class="icon-btn small del" aria-label="Sil">✕</button>
    </li>`).join('');
}

// ---------- gezinme ----------
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${state.tab}`));
  $('#fab').classList.toggle('hidden', state.tab === 'shopping');
  $('.month-nav').classList.toggle('invisible', state.tab === 'shopping' || state.tab === 'expected');
  window.scrollTo(0, 0);
}));

$('#prev-month').addEventListener('click', () => { state.month = addMonths(state.month, -1); render(); });
$('#next-month').addEventListener('click', () => { state.month = addMonths(state.month, 1); render(); });

$('#tx-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.txFilter = b.dataset.filter;
  $('#tx-filter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  renderTransactions();
});

// Hangi sekmedeysek + butonu ona uygun formu açar.
$('#fab').addEventListener('click', () => {
  if (state.tab === 'investments') openInvDialog(null);
  else if (state.tab === 'expected') openExpDialog(null);
  else openTxDialog(null);
});

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// Ay seçiliyse ve bugün o ayda değilse yeni kayıt varsayılan olarak o ayın 1'ine düşer.
function defaultDate() {
  return monthKey(state.month) === monthKey(new Date()) ? todayISO() : `${monthKey(state.month)}-01`;
}

// ---------- gelir / gider formu ----------
function setTxKind(kind, category) {
  state.txKind = kind;
  $('#tx-kind').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  const cats = kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  $('#tx-category').innerHTML = cats.map((c) => `<option>${esc(c)}</option>`).join('');
  if (category) $('#tx-category').value = category;
}

$('#tx-kind').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setTxKind(b.dataset.kind);
});

// preset: yeni kayıt için önceden doldurulacak alanlar (ör. beklenen gelir geldiğinde).
function openTxDialog(tx, preset = null) {
  state.editingTx = tx;
  state.receivingExp = null;
  const d = tx ?? preset;
  const f = $('#tx-form');
  f.reset();
  $('#tx-title').textContent = tx ? 'Kaydı düzenle' : 'Yeni kayıt';
  $('#tx-delete').classList.toggle('hidden', !tx);
  setTxKind(d?.kind || 'expense', d?.category);
  f.amount.value = d?.amount ?? '';
  f.date.value = d?.date ?? defaultDate();
  f.note.value = d?.note ?? '';
  $('#tx-dialog').showModal();
}

$('#tx-list').addEventListener('click', (e) => {
  const li = e.target.closest('li.editable');
  if (!li) return;
  const id = Number(li.dataset.id);
  if ('inv' in li.dataset) openInvDialog(state.investments.find((x) => x.id === id));
  else if ('wd' in li.dataset) {
    const w = state.withdrawals.find((x) => x.id === id);
    openWdDialog(state.investments.find((x) => x.id === w.investment_id), w);
  } else openTxDialog(state.transactions.find((t) => t.id === id));
});

$('#tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const row = {
    kind: state.txKind,
    amount: Number(f.amount.value),
    category: f.category.value,
    date: f.date.value,
    note: f.note.value.trim() || null,
  };
  const q = state.editingTx
    ? sb.from('transactions').update(row).eq('id', state.editingTx.id)
    : sb.from('transactions').insert(row);
  const { error } = await q;
  if (error) return fail(error);
  if (state.receivingExp) {
    const { error: e2 } = await sb.from('expected_incomes').update({ received: true }).eq('id', state.receivingExp.id);
    if (e2) fail(e2);
  }
  $('#tx-dialog').close();
  toast('Kaydedildi');
  loadAll();
});

$('#tx-delete').addEventListener('click', async () => {
  if (!state.editingTx) return;
  const { error } = await sb.from('transactions').delete().eq('id', state.editingTx.id);
  if (error) return fail(error);
  $('#tx-dialog').close();
  toast('Silindi');
  loadAll();
});

// ---------- yatırım formu ----------
$('#inv-type').innerHTML = ASSET_TYPES.map((c) => `<option>${esc(c)}</option>`).join('');

// Türün fiyatı takip edilen birimleri varsa birim seçimi görünür; "Diğer" seçilirse takip yapılmaz.
function setInvUnits(type, code) {
  const units = PRICED_UNITS[type] ?? [];
  $('#inv-unit-row').classList.toggle('hidden', !units.length);
  $('#inv-unit').innerHTML = units.map(([c, name]) => `<option value="${c}">${esc(name)}</option>`).join('')
    + (units.length ? '<option value="">Diğer (fiyat takibi yok)</option>' : '');
  $('#inv-unit').value = code ?? units[0]?.[0] ?? '';
  updateInvRate();
}

function updateInvRate() {
  const f = $('#inv-form');
  const code = f.rate_code.value;
  const r = state.rates[code];
  const unit = UNITS[code]?.unit;
  $('#inv-qty-label').textContent = unit ? `Miktar (${unit})` : 'Miktar / adet';
  f.quantity.required = !!code;
  $('#inv-amount-label').textContent = code ? 'Ödenen tutar (₺)' : 'Tutar (₺)';
  if (!r) { $('#inv-rate-hint').textContent = ''; return; }
  $('#inv-rate-hint').textContent = `Satış: 1 ${unit} = ${fmt(r.selling)} · ${stampFmt.format(new Date(r.updated_at))}`;
  if (!state.invAmountTouched && Number(f.quantity.value) > 0) {
    f.amount.value = (Math.round(Number(f.quantity.value) * Number(r.selling) * 100) / 100).toFixed(2);
  }
}

$('#inv-type').addEventListener('change', (e) => setInvUnits(e.target.value));
$('#inv-unit').addEventListener('change', updateInvRate);
$('#inv-form').quantity.addEventListener('input', updateInvRate);
$('#inv-form').amount.addEventListener('input', () => { state.invAmountTouched = true; });

// Hareketi olan aylar + seçili ay, yeniden eskiye. Kenarda para olmasa da bağlanabilir (eksiye düşer).
function fundingOptions(inv) {
  const keys = [...new Set([...state.transactions.map((t) => t.date.slice(0, 7)), monthKey(state.month),
    ...(inv?.funded_month ? [inv.funded_month.slice(0, 7)] : [])])].sort().reverse();
  const opts = ['<option value="">Bağlama — dış kaynak / eski birikim</option>'];
  for (const k of keys) {
    const value = `${k}-01`;
    const free = availableIn(parseDate(value), inv?.id);
    opts.push(`<option value="${value}">${monthFmt.format(parseDate(value))} — kenarda ${fmt(free)}</option>`);
  }
  return opts.join('');
}

// Yatırım bağlandığı ayın kenarda kalanını aşıyorsa uyarır; kaydı engellemez.
function updateFundHint() {
  const f = $('#inv-form');
  const month = f.funded_month.value;
  const left = month ? availableIn(parseDate(month), state.editingInv?.id) - Number(f.amount.value || 0) : 0;
  $('#inv-error').textContent = month && left < 0
    ? `Bu yatırımla ${monthFmt.format(parseDate(month))} kenarda kalanı ${fmt(left)} olacak.` : '';
}

$('#inv-funded').addEventListener('change', updateFundHint);
$('#inv-form').addEventListener('input', updateFundHint);

function openInvDialog(inv) {
  state.editingInv = inv;
  const f = $('#inv-form');
  f.reset();
  $('#inv-title').textContent = inv ? 'Yatırımı düzenle' : 'Yeni yatırım';
  f.asset_type.value = inv?.asset_type ?? ASSET_TYPES[0];
  f.amount.value = inv?.amount ?? '';
  f.quantity.value = inv?.quantity ?? '';
  // mevcut yatırımın tutarı alış maliyetidir, kurla üzerine yazılmaz
  state.invAmountTouched = !!inv;
  setInvUnits(f.asset_type.value, inv ? (inv.rate_code ?? '') : undefined);
  f.description.value = inv?.description ?? '';
  f.date.value = inv?.date ?? defaultDate();
  $('#inv-funded').innerHTML = fundingOptions(inv);
  // yeni yatırım varsayılan olarak seçili ayın birikimine bağlanır
  f.funded_month.value = inv ? (inv.funded_month ?? '') : `${monthKey(state.month)}-01`;
  updateFundHint();
  // Bozdurulmuş yatırımın tutarı/miktarı/bağlı olduğu ay değişirse geçmiş aylar ve kalan hesabı bozulur.
  const locked = !!inv && withdrawalsOf(inv).length > 0;
  for (const name of ['asset_type', 'rate_code', 'quantity', 'amount', 'funded_month']) f[name].disabled = locked;
  $('#inv-lock').textContent = locked ? `Bu yatırımdan çekiş yapıldı; tutarı ve bağlı olduğu ay değiştirilemez. Kalan: ${
    isPriced(inv) ? `${qtyFmt(qtyLeft(inv))} ${UNITS[inv.rate_code]?.unit ?? ''}` : fmt(costLeft(inv))}` : '';
  $('#inv-delete').classList.toggle('hidden', !inv || locked);
  $('#inv-withdraw').classList.toggle('hidden', !inv || costLeft(inv) <= 0);
  $('#inv-dialog').showModal();
}

$('#inv-withdraw').addEventListener('click', () => {
  const inv = state.editingInv;
  $('#inv-dialog').close();
  openWdDialog(inv, null);
});

$('#inv-list').addEventListener('click', (e) => {
  const li = e.target.closest('li.editable');
  if (li) openInvDialog(state.investments.find((x) => x.id === Number(li.dataset.id)));
});

$('#inv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const row = {
    asset_type: f.asset_type.value,
    amount: Number(f.amount.value),
    quantity: f.quantity.value ? Number(f.quantity.value) : null,
    rate_code: PRICED_UNITS[f.asset_type.value] ? f.rate_code.value || null : null,
    description: f.description.value.trim() || null,
    date: f.date.value,
    funded_month: f.funded_month.value || null,
  };
  const q = state.editingInv
    ? sb.from('investments').update(row).eq('id', state.editingInv.id)
    : sb.from('investments').insert(row);
  const { error } = await q;
  if (error) return fail(error);
  $('#inv-dialog').close();
  toast('Kaydedildi');
  loadAll();
});

$('#inv-delete').addEventListener('click', async () => {
  if (!state.editingInv) return;
  const { error } = await sb.from('investments').delete().eq('id', state.editingInv.id);
  if (error) return fail(error);
  $('#inv-dialog').close();
  toast('Silindi');
  loadAll();
});

// ---------- yatırımdan çekiş (bozdurma) ----------
// Ele geçen net para çekiş ayının kenarda kalanına eklenir; stopaj sadece yatırımdan düşer.
function openWdDialog(inv, w) {
  state.wdInv = inv;
  state.editingWd = w;
  const f = $('#wd-form');
  f.reset();
  $('#wd-title').textContent = w ? 'Çekişi düzenle' : 'Yatırımı boz / çek';
  const priced = isPriced(inv);
  const unit = UNITS[inv.rate_code]?.unit ?? '';
  $('#wd-info').textContent = `${invName(inv)} — kalan ${priced ? `${qtyFmt(qtyLeft(inv, w?.id))} ${unit}, ` : ''}maliyet ${fmt(costLeft(inv, w?.id))}`;
  $('#wd-qty-row').classList.toggle('hidden', !priced);
  $('#wd-qty-label').textContent = `Satılan miktar (${unit})`;
  f.quantity.required = priced;
  f.quantity.value = w?.quantity ?? '';
  f.amount.value = w?.amount ?? '';
  f.tax.value = w && Number(w.tax) > 0 ? w.tax : '';
  f.date.value = w?.date ?? todayISO();
  f.note.value = w?.note ?? '';
  $('#wd-delete').classList.toggle('hidden', !w);
  updateWdHint();
  $('#wd-dialog').showModal();
}

function updateWdHint() {
  const f = $('#wd-form');
  const inv = state.wdInv;
  if (!inv) return;
  const over = isPriced(inv) ? Number(f.quantity.value || 0) > qtyLeft(inv, state.editingWd?.id)
    : Number(f.amount.value || 0) + Number(f.tax.value || 0) > costLeft(inv, state.editingWd?.id);
  const month = f.date.value ? monthFmt.format(parseDate(f.date.value)) : 'O ayın';
  $('#wd-hint').textContent = over ? 'Kalandan fazla çekiliyor; kalan sıfırlanır.'
    : `Net tutar ${month} kenarda kalanına eklenir. Bu parayla ödediğin gideri ayrıca girebilirsin.`;
}

$('#wd-form').addEventListener('input', updateWdHint);

$('#wd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const row = {
    investment_id: state.wdInv.id,
    amount: Number(f.amount.value),
    tax: Number(f.tax.value || 0),
    quantity: isPriced(state.wdInv) ? Number(f.quantity.value) : null,
    date: f.date.value,
    note: f.note.value.trim() || null,
  };
  const q = state.editingWd
    ? sb.from('withdrawals').update(row).eq('id', state.editingWd.id)
    : sb.from('withdrawals').insert(row);
  const { error } = await q;
  if (error) return fail(error);
  $('#wd-dialog').close();
  toast('Kaydedildi');
  loadAll();
});

$('#wd-delete').addEventListener('click', async () => {
  if (!state.editingWd) return;
  const { error } = await sb.from('withdrawals').delete().eq('id', state.editingWd.id);
  if (error) return fail(error);
  $('#wd-dialog').close();
  toast('Silindi');
  loadAll();
});

// ---------- beklenen gelirler ----------
$('#exp-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.expFilter = b.dataset.filter;
  $('#exp-filter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  renderExpected();
});

// Taksit tutarları kuruş hassasiyetinde; toplam eşit bölünmüyorsa artan kuruşlar son taksite eklenir.
function installmentAmounts(amount, count, type) {
  if (type === 'each') return Array(count).fill(amount);
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? cents - base * (count - 1) : base) / 100);
}

function setExpMode(mode) {
  state.expMode = mode;
  $('#exp-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const inst = mode === 'installment';
  // gizli alanlar form doğrulamasına takılmasın diye fieldset kapatılır
  $('#exp-installment').classList.toggle('hidden', !inst);
  $('#exp-installment').disabled = !inst;
  $('#exp-date-label').textContent = inst ? 'İlk taksit tarihi' : 'Tarih';
  updateExpPreview();
}

function updateExpPreview() {
  const f = $('#exp-form');
  const count = Number(f.count.value);
  const amount = Number(f.amount.value);
  if (state.expMode !== 'installment' || !Number.isInteger(count) || count < 2 || !(amount > 0)) {
    $('#exp-preview').textContent = '';
    return;
  }
  const parts = installmentAmounts(amount, count, f.amount_type.value);
  const last = f.date.value ? `, son taksit ${fullDayFmt.format(parseDate(addMonthsISO(f.date.value, count - 1)))}` : '';
  $('#exp-preview').textContent = `Her ay ${fmt(parts[0])} × ${count} = ${fmt(sum(parts))}${last}`;
}

$('#exp-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setExpMode(b.dataset.mode);
});
$('#exp-form').addEventListener('input', updateExpPreview);

function openExpDialog(x) {
  state.editingExp = x;
  const f = $('#exp-form');
  f.reset();
  $('#exp-title').textContent = !x ? 'Beklenen gelir'
    : x.plan_id ? `Taksit ${x.installment_no}/${x.installment_count}` : 'Beklenen geliri düzenle';
  $('#exp-mode').classList.toggle('hidden', !!x);
  setExpMode('single');
  $('#exp-amount-label').textContent = x?.plan_id ? 'Bu taksitin tutarı (₺)' : 'Tutar (₺)';
  f.source.value = x?.source ?? '';
  f.amount.value = x?.amount ?? '';
  f.date.value = x?.date ?? todayISO();
  f.note.value = x?.note ?? '';
  $('#exp-delete').classList.toggle('hidden', !x);
  $('#exp-delete-plan').classList.toggle('hidden', !x?.plan_id);
  $('#exp-receive').classList.toggle('hidden', !x || x.received);
  $('#exp-unreceive').classList.toggle('hidden', !x?.received);
  $('#exp-dialog').showModal();
}

$('#exp-groups').addEventListener('click', (e) => {
  const li = e.target.closest('li.editable');
  if (li) openExpDialog(state.expected.find((x) => x.id === Number(li.dataset.id)));
});

$('#exp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const base = { source: f.source.value.trim(), note: f.note.value.trim() || null };
  if (!base.source) return;
  const amount = Number(f.amount.value);
  let q;
  if (state.editingExp) {
    q = sb.from('expected_incomes').update({ ...base, amount, date: f.date.value }).eq('id', state.editingExp.id);
  } else if (state.expMode === 'installment') {
    const count = Number(f.count.value);
    const plan_id = crypto.randomUUID();
    const rows = installmentAmounts(amount, count, f.amount_type.value).map((a, i) => ({
      ...base, amount: a, date: addMonthsISO(f.date.value, i), plan_id, installment_no: i + 1, installment_count: count,
    }));
    q = sb.from('expected_incomes').insert(rows);
  } else {
    q = sb.from('expected_incomes').insert({ ...base, amount, date: f.date.value });
  }
  const { error } = await q;
  if (error) return fail(error);
  $('#exp-dialog').close();
  toast('Kaydedildi');
  loadAll();
});

// Ödeme gelince gelir formu dolu açılır; kaydedilince beklenen gelir "geldi" olur.
$('#exp-receive').addEventListener('click', () => {
  const x = state.editingExp;
  if (!x) return;
  $('#exp-dialog').close();
  const note = x.plan_id ? `${x.source} (taksit ${x.installment_no}/${x.installment_count})` : x.source;
  openTxDialog(null, { kind: 'income', category: 'Diğer', amount: x.amount, date: todayISO(), note });
  state.receivingExp = x;
  $('#tx-title').textContent = 'Gelen ödemeyi kaydet';
});

$('#exp-unreceive').addEventListener('click', async () => {
  if (!state.editingExp) return;
  const { error } = await sb.from('expected_incomes').update({ received: false }).eq('id', state.editingExp.id);
  if (error) return fail(error);
  $('#exp-dialog').close();
  toast('Tekrar bekleyenlere alındı');
  loadAll();
});

$('#exp-delete').addEventListener('click', async () => {
  if (!state.editingExp) return;
  const { error } = await sb.from('expected_incomes').delete().eq('id', state.editingExp.id);
  if (error) return fail(error);
  $('#exp-dialog').close();
  toast('Silindi');
  loadAll();
});

$('#exp-delete-plan').addEventListener('click', async () => {
  const x = state.editingExp;
  if (!x?.plan_id) return;
  const { error } = await sb.from('expected_incomes').delete().eq('plan_id', x.plan_id).eq('received', false);
  if (error) return fail(error);
  $('#exp-dialog').close();
  toast('Kalan taksitler silindi');
  loadAll();
});

// ---------- alışveriş listesi ----------
$('#shop-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const row = { name: f.name.value.trim(), quantity: f.quantity.value.trim() || null };
  if (!row.name) return;
  f.reset();
  f.name.focus();
  const { error } = await sb.from('shopping_items').insert(row);
  if (error) return fail(error);
  loadAll();
});

$('#shop-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = Number(li.dataset.id);
  if (e.target.closest('.del')) {
    state.shopping = state.shopping.filter((s) => s.id !== id);
    renderShopping();
    const { error } = await sb.from('shopping_items').delete().eq('id', id);
    if (error) fail(error);
    return;
  }
  if (e.target.matches('input[type=checkbox]')) {
    const item = state.shopping.find((s) => s.id === id);
    const checked = e.target.checked;
    // anında göster, sonra kaydet
    Object.assign(item, { checked, checked_by: checked ? state.user.id : null });
    renderShopping();
    const { error } = await sb.from('shopping_items').update({ checked, checked_by: item.checked_by }).eq('id', id);
    if (error) { fail(error); loadAll(); }
  }
});

$('#shop-clear').addEventListener('click', async () => {
  const ids = state.shopping.filter((s) => s.checked).map((s) => s.id);
  state.shopping = state.shopping.filter((s) => !s.checked);
  renderShopping();
  const { error } = await sb.from('shopping_items').delete().in('id', ids);
  if (error) { fail(error); loadAll(); }
});

// ---------- başlangıç ----------
const { data: { session } } = await sb.auth.getSession();
if (!session) $('#auth-view').classList.remove('hidden');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
