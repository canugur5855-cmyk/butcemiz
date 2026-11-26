import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EXPENSE_CATEGORIES = ['Kredi kartı ekstresi', 'Nakit harcama', 'Kira', 'Faturalar', 'Market', 'Kredi / Taksit', 'Diğer'];
const INCOME_CATEGORIES = ['Maaş', 'Ek gelir', 'Diğer'];
// Yatırımlar alınan şeyin kendi cinsinden tutulur (300 $, 5 gr ...). TL sadece o ay cepten çıkan/giren paradır.
const ASSETS = [['Dolar', '$'], ['Euro', '€'], ['Gram altın', 'gr'], ['Çeyrek altın', 'adet'], ['22 ayar bilezik', 'gr'],
  ['Yarım altın', 'adet'], ['Tam altın', 'adet'], ['Cumhuriyet altını', 'adet'], ['Sterlin', '£'], ['Gümüş', 'gr'], ['Fon', 'pay']];
const CUSTOM = '__custom';

const state = {
  user: null,
  profiles: {},          // id -> display_name
  people: [],            // sütun sırası: Uğur, İzgi
  transactions: [],
  investments: [],
  shopping: [],
  expected: [],
  month: startOfMonth(new Date()),
  tab: 'summary',
  txFilter: 'all',
  // kayıt formu
  editing: null,         // { type: 'tx' | 'inv', row }
  kind: 'expense',       // expense | income | invest
  category: null,
  dir: 'buy',            // buy | sell | transfer
  incCur: 'tl',          // gelir: tl | asset (döviz/altın olarak gelen)
  asset: null,           // "ad|birim" ya da CUSTOM
  // beklenen gelir formu
  editingExp: null,
  expMode: 'single',
  expFilter: 'pending',
  channel: null,
};

// ---------- yardımcılar ----------
const $ = (sel) => document.querySelector(sel);
const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });
const fmt = (n) => money.format(n || 0);
const monthFmt = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });
const fullDayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
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
function day(iso) { return dayFmt.format(parseDate(iso)); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function nameOf(id) { return state.profiles[id] || '—'; }
function sum(arr, f = (x) => x) { return arr.reduce((a, x) => a + Number(f(x)), 0); }
function byNewest(a, b) { return b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)); }

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

// Yatırım miktarının okunuşu: "500 $", "1 Çeyrek altın", "9,52 gr 22 ayar bilezik"
function assetKey(x) { return `${x.asset}|${x.unit}`; }
function holdingText(asset, unit, qty) {
  const q = qtyFmt(qty);
  if (['$', '€', '£'].includes(unit)) return `${q} ${unit}`;
  if (unit === 'adet') return `${q} ${asset}`;
  return `${q} ${unit} ${asset}`;
}
// Aktarma (kind = 'transfer'): user_id veren, to_user_id alan; TL yok, ay hesabına karışmaz.
// Döviz/altın gelir (kind = 'income'): gelir olarak gelen 500 $ gibi; doğrudan birikime girer, TL yok.
function involves(x, id) { return x.user_id === id || x.to_user_id === id; }
// Miktarın kişiye göre işareti; id verilmezse hane toplamı (aktarma toplamı değiştirmez)
function qtyFor(x, id = null) {
  const q = Number(x.quantity);
  if (x.kind === 'buy' || x.kind === 'income') return q;
  if (x.kind === 'sell') return -q;
  if (!id) return 0;
  return x.user_id === id ? -q : q;
}

// ---------- kimlik doğrulama ----------
// Kullanıcı adıyla giriş: Supabase arka planda e-posta istediği için kullanıcı adı sabit bir
// sahte alan adına çevrilir (ugur → ugur@butcemiz.local). Bu adrese hiç e-posta gönderilmez.
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
// Sunucuya ulaşılamazsa boş ekran yerine uyarı ve "Tekrar dene" gösterilir; birkaç kez kendisi de dener.
async function loadAll(attempt = 0) {
  let res;
  try {
    res = await Promise.all([
      sb.from('profiles').select('id, display_name, created_at'),
      sb.from('transactions').select('*'),
      sb.from('investments').select('*'),
      sb.from('shopping_items').select('*').order('checked').order('created_at', { ascending: false }),
      sb.from('expected_incomes').select('*').order('date').order('id'),
    ]);
  } catch (err) {
    res = [{ error: err }];
  }
  const err = res.find((q) => q.error)?.error;
  $('#net-error').classList.toggle('hidden', !err);
  if (err) {
    console.error(err);
    if (attempt < 3) setTimeout(() => loadAll(attempt + 1), 2000 * (attempt + 1));
    return;
  }
  const [p, t, i, s, x] = res;
  state.profiles = Object.fromEntries(p.data.map((r) => [r.id, r.display_name]));
  // Sütun sırası sabit: Uğur solda, İzgi sağda (kim girerse girsin)
  const order = ['Uğur', 'İzgi'];
  state.people = p.data.map((r) => r.id).sort((a, b) => {
    const ia = order.indexOf(nameOf(a)), ib = order.indexOf(nameOf(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  state.transactions = t.data.sort(byNewest);
  // eski sürümden kalan, adı/birimi boş yatırım olursa türü ad sayılır
  state.investments = i.data.map((r) => ({ ...r, asset: r.asset ?? r.asset_type, unit: r.unit ?? 'adet' })).sort(byNewest);
  state.shopping = s.data;
  state.expected = x.data;
  render();
}

$('#net-retry').addEventListener('click', () => loadAll());

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadAll, 250);
}

function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  let ch = sb.channel('household');
  for (const table of ['transactions', 'investments', 'shopping_items', 'expected_incomes']) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleReload);
  }
  state.channel = ch.subscribe();
}

// Uygulamaya geri dönüldüğünde (telefon kilidi açılınca vb.) verileri tazele.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) loadAll();
});

// ---------- hesaplar ----------
// Ayın parasından çıkan alım; 'opening' = uygulamadan önce zaten elde olan, TL'si o aya girmez
function spent(x) { return x.kind === 'buy' && !x.opening; }
function inMonth(rows, month = state.month) {
  const key = monthKey(month);
  return rows.filter((r) => r.date.startsWith(key));
}
function monthTotals(month = state.month) {
  const tx = inMonth(state.transactions, month);
  const inv = inMonth(state.investments, month);
  const income = sum(tx.filter((t) => t.kind === 'income'), (t) => t.amount);
  const expense = sum(tx.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const bought = sum(inv.filter(spent), (x) => x.amount);
  const sold = sum(inv.filter((x) => x.kind === 'sell'), (x) => x.amount);
  return { income, expense, bought, sold, left: income - expense - bought + sold };
}
// Kişinin (ya da herkesin) elindeki yatırımlar: alınan − bozdurulan, kendi cinsinden
function holdings(rows, id = null) {
  const m = new Map();
  for (const x of rows) {
    const k = assetKey(x);
    const h = m.get(k) ?? { asset: x.asset, unit: x.unit, qty: 0 };
    h.qty += qtyFor(x, id);
    m.set(k, h);
  }
  return [...m.values()].filter((h) => Math.abs(h.qty) > 1e-9).sort((a, b) => a.asset.localeCompare(b.asset, 'tr'));
}

// ---------- render ----------
function render() {
  $('#month-label').textContent = monthFmt.format(state.month);
  renderSummary();
  renderTransactions();
  renderSavings();
  renderExpected();
  renderShopping();
}

// İki sütun: her kişinin kalemleri alt alta, en altta (istenirse) kişinin toplamı
function columns(rows, itemHtml, totalOf, belongs = (r, id) => r.user_id === id) {
  return state.people.map((id) => {
    const mine = rows.filter((r) => belongs(r, id));
    return `<div class="col">
      <div class="col-head">${esc(nameOf(id))}</div>
      ${mine.length ? `<ul class="mini-list">${mine.map((r) => itemHtml(r, id)).join('')}</ul>` : '<p class="col-empty">—</p>'}
      ${totalOf ? `<div class="col-total"><span>Toplam</span><strong>${fmt(totalOf(mine))}</strong></div>` : ''}
    </div>`;
  }).join('');
}

function txMini(t) {
  return `<li class="mini editable" data-type="tx" data-id="${t.id}">
    <div class="mini-top"><span>${esc(t.category)}</span><b>${fmt(t.amount)}</b></div>
    <small>${day(t.date)}${t.note ? ` · ${esc(t.note)}` : ''}</small>
  </li>`;
}
// Gelir sütununda hem TL gelirler hem döviz/altın olarak gelenler
function incMini(r) {
  if (r.type !== 'inv') return txMini(r);
  return `<li class="mini editable" data-type="inv" data-id="${r.id}">
    <div class="mini-top"><span>${esc(r.category || 'Gelir')}</span><b>${esc(holdingText(r.asset, r.unit, r.quantity))}</b></div>
    <small>${day(r.date)}${r.note ? ` · ${esc(r.note)}` : ''}</small>
  </li>`;
}
// id: hangi kişinin sütununda gösterildiği (aktarma verende −, alanda + görünür)
function invMini(x, id) {
  const out = qtyFor(x, id) < 0;
  const what = x.kind === 'sell' ? ' · bozduruldu'
    : x.opening ? ' · önceden vardı'
    : x.kind === 'income' ? ` · gelir${x.category ? ` (${esc(x.category)})` : ''}`
    : x.kind === 'transfer' ? (out ? ` · ${esc(toName(nameOf(x.to_user_id)))} aktarıldı` : ` · ${esc(fromName(nameOf(x.user_id)))} geldi`) : '';
  return `<li class="mini editable ${out ? 'sell' : ''}" data-type="inv" data-id="${x.id}">
    <div class="mini-top"><span>${out ? '−' : '+'}${esc(holdingText(x.asset, x.unit, x.quantity))}</span></div>
    <small>${day(x.date)}${what}${x.note ? ` · ${esc(x.note)}` : ''}</small>
  </li>`;
}

function renderSummary() {
  const tx = inMonth(state.transactions);
  const inc = tx.filter((t) => t.kind === 'income');
  const out = tx.filter((t) => t.kind === 'expense');
  const amt = (rows) => sum(rows, (t) => t.amount);
  $('#inc-total').textContent = fmt(amt(inc));
  $('#out-total').textContent = fmt(amt(out));
  const incAll = [...inc, ...inMonth(state.investments).filter((x) => x.kind === 'income').map((x) => ({ ...x, type: 'inv' }))].sort(byNewest);
  $('#inc-cols').innerHTML = columns(incAll, incMini, amt);
  $('#out-cols').innerHTML = columns(out, txMini, amt);
  $('#inv-cols').innerHTML = columns(inMonth(state.investments), invMini, null, involves);
  const { left } = monthTotals();
  $('#month-left').textContent = fmt(left);
  $('#month-left').classList.toggle('negative', left < 0);
}

function renderTransactions() {
  // filtre düğmeleri isimlerle: Hepsi / Uğur / İzgi
  $('#tx-filter').innerHTML = [['all', 'Hepsi'], ...state.people.map((id) => [id, nameOf(id)])]
    .map(([v, label]) => `<button data-filter="${v}" class="${state.txFilter === v ? 'active' : ''}">${esc(label)}</button>`).join('');
  const own = (r) => state.txFilter === 'all' || involves(r, state.txFilter);

  const tx = inMonth(state.transactions).filter(own);
  const inv = inMonth(state.investments).filter(own);
  const income = sum(tx.filter((t) => t.kind === 'income'), (t) => t.amount);
  const expense = sum(tx.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const bought = sum(inv.filter(spent), (x) => x.amount);
  const sold = sum(inv.filter((x) => x.kind === 'sell'), (x) => x.amount);
  const left = income - expense - bought + sold;
  $('#tx-strip').innerHTML = `
    <div><span>Gelir</span><strong class="income">${fmt(income)}</strong></div>
    <div><span>Gider</span><strong class="expense">${fmt(expense)}</strong></div>
    <div><span>Yatırıma giden</span><strong class="invest">${fmt(bought)}</strong></div>
    ${sold > 0 ? `<div><span>Bozdurulan</span><strong class="income">${fmt(sold)}</strong></div>` : ''}
    <div><span>Elde kalan</span><strong class="net ${left < 0 ? 'negative' : ''}">${fmt(left)}</strong></div>`;

  const rows = [...tx.map((t) => ({ ...t, type: 'tx' })), ...inv.map((x) => ({ ...x, type: 'inv' }))].sort(byNewest);
  $('#tx-empty').classList.toggle('hidden', rows.length > 0);
  $('#tx-list').innerHTML = rows.map((r) => {
    let title, cls, sign;
    if (r.type === 'inv' && r.kind === 'income') {
      return `<li class="item editable" data-type="inv" data-id="${r.id}">
      <div class="item-main">
        <div class="item-title">${esc(r.category || 'Gelir')}${r.note ? ` <span class="muted">· ${esc(r.note)}</span>` : ''}</div>
        <div class="item-sub">${day(r.date)} <span class="who">${esc(nameOf(r.user_id))}</span> <span class="tag">birikime girdi</span></div>
      </div>
      <div class="amount income">+${esc(holdingText(r.asset, r.unit, r.quantity))}</div>
    </li>`;
    }
    if (r.type === 'inv' && r.opening) {
      return `<li class="item editable" data-type="inv" data-id="${r.id}">
      <div class="item-main">
        <div class="item-title">📦 ${esc(holdingText(r.asset, r.unit, r.quantity))} önceden vardı${r.note ? ` <span class="muted">· ${esc(r.note)}</span>` : ''}</div>
        <div class="item-sub">${day(r.date)} <span class="who">${esc(nameOf(r.user_id))}</span> <span class="tag">yatırım</span></div>
      </div>
      <div class="amount muted-amount">TL yok</div>
    </li>`;
    }
    if (r.type === 'inv' && r.kind === 'transfer') {
      return `<li class="item editable" data-type="inv" data-id="${r.id}">
      <div class="item-main">
        <div class="item-title">🔁 ${esc(holdingText(r.asset, r.unit, r.quantity))} aktarıldı${r.note ? ` <span class="muted">· ${esc(r.note)}</span>` : ''}</div>
        <div class="item-sub">${day(r.date)} <span class="who">${esc(nameOf(r.user_id))} → ${esc(nameOf(r.to_user_id))}</span> <span class="tag">yatırım</span></div>
      </div>
      <div class="amount muted-amount">TL yok</div>
    </li>`;
    }
    if (r.type === 'inv') {
      const sell = r.kind === 'sell';
      title = `${sell ? '↩' : '📈'} ${esc(holdingText(r.asset, r.unit, r.quantity))} ${sell ? 'bozduruldu' : 'alındı'}`;
      cls = sell ? 'income' : 'invest';
      sign = sell ? '+' : '−';
    } else {
      title = esc(r.category);
      cls = r.kind;
      sign = r.kind === 'income' ? '+' : '−';
    }
    return `<li class="item editable" data-type="${r.type}" data-id="${r.id}">
      <div class="item-main">
        <div class="item-title">${title}${r.note ? ` <span class="muted">· ${esc(r.note)}</span>` : ''}</div>
        <div class="item-sub">${day(r.date)} <span class="who">${esc(nameOf(r.user_id))}</span>${r.type === 'inv' ? ' <span class="tag">yatırım</span>' : ''}</div>
      </div>
      <div class="amount ${cls}">${sign}${fmt(r.amount)}</div>
    </li>`;
  }).join('');
}

function holdingsHtml(list) {
  return list.length
    ? list.map((h) => `<div class="holding ${h.qty < 0 ? 'negative' : ''}">${esc(holdingText(h.asset, h.unit, h.qty))}</div>`).join('')
    : '<p class="col-empty">Henüz yatırım yok.</p>';
}

function renderSavings() {
  $('#sv-total').innerHTML = holdingsHtml(holdings(state.investments));
  $('#sv-cols').innerHTML = state.people.map((id) => {
    const mine = state.investments.filter((x) => involves(x, id));
    return `<div class="col">
      <div class="col-head">${esc(nameOf(id))}</div>
      <div class="holdings">${holdingsHtml(holdings(mine, id))}</div>
      ${mine.length ? `<div class="col-sub">Kalem kalem</div><ul class="mini-list">${mine.map((x) => invMini(x, id)).join('')}</ul>` : ''}
    </div>`;
  }).join('');
}

function renderExpected() {
  const today = todayISO();
  const rows = state.expFilter === 'pending'
    ? state.expected.filter((x) => !x.received)
    : state.expected.filter((x) => x.received).reverse();
  const groups = new Map();
  for (const x of rows) {
    const k = x.date.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  $('#exp-empty').textContent = state.expFilter === 'pending' ? 'Beklenen gelir yok.' : 'Henüz ödenen yok.';
  $('#exp-empty').classList.toggle('hidden', rows.length > 0);
  $('#exp-groups').innerHTML = [...groups].map(([k, xs]) => `
    <div class="group-head"><span>${monthFmt.format(parseDate(`${k}-01`))}</span><span>${fmt(sum(xs, (x) => x.amount))}</span></div>
    <ul class="list">${xs.map((x) => `
      <li class="item exp-item ${x.received ? 'checked' : ''}" data-id="${x.id}">
        <label class="check"><input type="checkbox" ${x.received ? 'checked' : ''}><span class="box"></span></label>
        <div class="item-main editable">
          <div class="item-title">${esc(x.source)}${x.plan_id ? ` <span class="muted">· Taksit ${x.installment_no}/${x.installment_count}</span>` : ''}${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ''}</div>
          <div class="item-sub">${day(x.date)}${!x.received && x.date < today ? ' <span class="late">gecikti</span>' : ''} <span class="who">${esc(nameOf(x.user_id))}</span></div>
        </div>
        <div class="amount muted-amount">${fmt(x.amount)}</div>
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
const PAGE_TITLES = { savings: 'Toplam birikim', expected: 'Beklenen gelirler', shopping: 'Alışveriş listesi' };

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${state.tab}`));
  $('#fab').classList.toggle('hidden', state.tab === 'shopping');
  const title = PAGE_TITLES[state.tab];
  $('.month-nav').classList.toggle('hidden', !!title);
  $('#page-title').classList.toggle('hidden', !title);
  $('#page-title').textContent = title ?? '';
  window.scrollTo(0, 0);
}));

$('#prev-month').addEventListener('click', () => { state.month = addMonths(state.month, -1); render(); });
$('#next-month').addEventListener('click', () => { state.month = addMonths(state.month, 1); render(); });

$('#tx-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.txFilter = b.dataset.filter;
  renderTransactions();
});

// + düğmesi: Beklenen sekmesinde not ekler, Birikim'de yatırım, diğerlerinde gider formu açar
$('#fab').addEventListener('click', () => {
  if (state.tab === 'expected') openExpDialog(null);
  else openEntry(null, state.tab === 'savings' ? 'invest' : 'expense');
});

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// Listelerdeki bir kayda dokununca düzenleme formu açılır (ikiniz de her kaydı düzenleyebilirsiniz)
for (const sel of ['#tab-summary', '#tx-list', '#sv-cols']) {
  $(sel).addEventListener('click', (e) => {
    const li = e.target.closest('.editable[data-type]');
    if (!li) return;
    const id = Number(li.dataset.id);
    if (li.dataset.type === 'inv') openEntry({ type: 'inv', row: state.investments.find((x) => x.id === id) });
    else openEntry({ type: 'tx', row: state.transactions.find((x) => x.id === id) });
  });
}

// Seçili ay bu ay değilse yeni kayıt o ayın 1'ine düşer.
function defaultDate() {
  return monthKey(state.month) === monthKey(new Date()) ? todayISO() : `${monthKey(state.month)}-01`;
}

// ---------- kayıt formu: gider / gelir / yatırım ----------
// "Kimin?" seçimi: ikiniz de birbirinizin adına kayıt girebilirsiniz; varsayılan girenin kendisi.
function renderOwner(el, owner) {
  el.innerHTML = state.people.map((id) => `<button type="button" data-owner="${id}">${esc(nameOf(id))}</button>`).join('');
  el.classList.toggle('hidden', state.people.length < 2);
  setOwner(el, owner ?? state.user.id);
}
function setOwner(el, id) {
  el.dataset.value = id;
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.owner === id));
  if (el.id === 'tx-owner') updateInvHint();
}
for (const el of [$('#tx-owner'), $('#exp-owner')]) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setOwner(el, b.dataset.owner);
  });
}

// Kategoriler tek dokunuşla seçilir; en çok kullanılanlar başta ve varsayılan seçili gelir.
function renderCategories(kind, selected) {
  const base = kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const uses = {};
  for (const t of state.transactions) if (t.kind === kind) uses[t.category] = (uses[t.category] || 0) + 1;
  const cats = [...new Set([...base, ...Object.keys(uses)])].sort((a, b) => (uses[b] || 0) - (uses[a] || 0));
  if (selected && !cats.includes(selected)) cats.unshift(selected);
  $('#tx-category').innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  setCategory(selected ?? cats[0]);
}
function setCategory(cat) {
  state.category = cat;
  $('#tx-category').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
}

// Yatırım cinsleri: kullanılanlar başta, sonra hazır liste, en sonda "Diğer…"
function assetOptions() {
  const uses = new Map();
  for (const x of state.investments) uses.set(assetKey(x), (uses.get(assetKey(x)) || 0) + 1);
  const keys = [...new Set([...uses.keys(), ...ASSETS.map(([a, u]) => `${a}|${u}`)])];
  return keys.sort((a, b) => (uses.get(b) || 0) - (uses.get(a) || 0));
}
function renderAssets(selected) {
  const keys = assetOptions();
  if (selected && selected !== CUSTOM && !keys.includes(selected)) keys.unshift(selected);
  $('#inv-assets').innerHTML = keys.map((k) => `<button type="button" data-asset="${esc(k)}">${esc(k.split('|')[0])}</button>`).join('')
    + `<button type="button" data-asset="${CUSTOM}">Diğer…</button>`;
  setAsset(selected ?? keys[0]);
}
function setAsset(key) {
  state.asset = key;
  $('#inv-assets').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.asset === key));
  const custom = key === CUSTOM;
  $('#inv-custom').classList.toggle('hidden', !custom);
  const f = $('#tx-form');
  f.asset.required = custom;
  f.unit.required = custom;
  updateInvHint();
}
function currentAsset() {
  const f = $('#tx-form');
  if (state.asset === CUSTOM) return { asset: f.asset.value.trim(), unit: f.unit.value.trim() || 'adet' };
  const [asset, unit] = state.asset.split('|');
  return { asset, unit };
}

// Miktar etiketi ve bozdururken "elinde ne kadar var" bilgisi
function inKind() { return state.kind === 'income' && state.incCur === 'asset'; }
function updateInvHint() {
  if (!(state.kind === 'invest' || inKind()) || !state.asset) return;
  const f = $('#tx-form');
  const { asset, unit } = currentAsset();
  $('#inv-qty-label').textContent = unit ? `Miktar (${unit})` : 'Miktar';
  const owner = $('#tx-owner').dataset.value;
  const editId = state.editing?.type === 'inv' ? state.editing.row.id : null;
  const have = sum(state.investments.filter((x) => involves(x, owner) && x.asset === asset && x.unit === unit && x.id !== editId),
    (x) => qtyFor(x, owner));
  if (state.kind === 'invest' && state.dir !== 'buy' && asset) {
    const over = Number(f.quantity.value || 0) > have + 1e-9;
    const to = state.dir === 'transfer' ? `${nameOf(owner)} → ${nameOf(otherOf(owner))} · ` : '';
    $('#inv-hint').textContent = `${to}${nameOf(owner)}: elde ${holdingText(asset, unit, have)}${over ? ` — bundan fazlası ${state.dir === 'sell' ? 'bozduruluyor' : 'aktarılıyor'}!` : ''}`;
    $('#inv-hint').classList.toggle('warn', over);
  } else {
    $('#inv-hint').textContent = '';
  }
}

function setKind(kind) {
  state.kind = kind;
  $('#tx-kind').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  const inv = kind === 'invest';
  const assetForm = inv || inKind();
  // TL / döviz-altın seçimi sadece yeni gelirde (düzenlerken tablo değişmesin)
  $('#inc-cur').classList.toggle('hidden', kind !== 'income' || !!state.editing);
  $('#inc-cur').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.cur === state.incCur));
  $('#inv-fields').classList.toggle('hidden', !assetForm);
  $('#inv-fields').disabled = !assetForm;
  $('#inv-dir').classList.toggle('hidden', !inv);
  $('#tx-category').classList.toggle('hidden', inv);
  if (!inv) renderCategories(kind, state.editing?.row.kind === kind ? state.editing.row.category : null);
  setDir(state.dir);
}
// Türkçe ek: Uğur'a / İzgi'ye, Uğur'dan / İzgi'den
function lastVowel(w) { return [...w.toLocaleLowerCase('tr')].reverse().find((c) => 'aeıioöuü'.includes(c)) ?? 'e'; }
function toName(n) { const back = 'aıou'.includes(lastVowel(n)); const v = 'aeıioöuü'.includes(n.slice(-1).toLocaleLowerCase('tr')); return `${n}'${v ? 'y' : ''}${back ? 'a' : 'e'}`; }
function fromName(n) { const back = 'aıou'.includes(lastVowel(n)); const hard = 'çfhkpsşt'.includes(n.slice(-1).toLocaleLowerCase('tr')); return `${n}'${hard ? 't' : 'd'}${back ? 'an' : 'en'}`; }
function otherOf(id) { return state.people.find((p) => p !== id); }
// Aktarmada TL girilmez; "kimin" seçimi veren kişidir, alan otomatik olarak diğer eş olur.
function setDir(dir) {
  state.dir = dir;
  $('#inv-dir').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.dir === dir));
  const transfer = (state.kind === 'invest' && dir === 'transfer') || inKind();
  $('#amount-label').textContent = state.kind !== 'invest' ? 'Tutar (₺)'
    : dir === 'buy' ? 'Kaç TL verdiniz? (₺)' : 'Eline geçen TL (₺)';
  $('#amount-label').classList.toggle('hidden', transfer);
  const amount = $('#tx-form').amount;
  amount.classList.toggle('hidden', transfer);
  amount.disabled = transfer;
  updateInvHint();
}

$('#tx-kind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setKind(b.dataset.kind); });
$('#inc-cur').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.incCur = b.dataset.cur;
  setKind('income');
});
$('#inv-dir').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setDir(b.dataset.dir); });
$('#tx-category').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setCategory(b.dataset.cat); });
$('#inv-assets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setAsset(b.dataset.asset); });
$('#tx-form').addEventListener('input', updateInvHint);

// editing: { type: 'tx' | 'inv', row } ya da null (yeni kayıt)
function openEntry(editing, kind = 'expense') {
  state.editing = editing;
  const r = editing?.row;
  const f = $('#tx-form');
  f.reset();
  const incomeAsset = editing?.type === 'inv' && r.kind === 'income';
  const k = editing ? (editing.type === 'inv' && !incomeAsset ? 'invest' : r.kind) : kind;
  state.incCur = incomeAsset ? 'asset' : 'tl';
  $('#tx-title').textContent = !editing ? 'Yeni kayıt' : k === 'invest' ? 'Yatırımı düzenle' : 'Kaydı düzenle';
  $('#tx-delete').classList.toggle('hidden', !editing);
  // düzenlerken gelir/gider yatırıma ya da yatırım gelir/gidere çevrilemez
  $('#tx-kind').classList.toggle('hidden', editing?.type === 'inv');
  $('#tx-kind [data-kind="invest"]').classList.toggle('hidden', editing?.type === 'tx');
  renderOwner($('#tx-owner'), r?.user_id);
  state.dir = editing?.type === 'inv' ? r.kind : 'buy';
  renderAssets(editing?.type === 'inv' ? assetKey(r) : undefined);
  setKind(k);
  f.amount.value = r && Number(r.amount) > 0 ? r.amount : '';
  f.quantity.value = editing?.type === 'inv' ? Number(r.quantity) : '';
  f.date.value = r?.date ?? defaultDate();
  f.note.value = r?.note ?? '';
  updateInvHint();
  $('#tx-dialog').showModal();
  if (!editing) (k === 'invest' ? f.quantity : f.amount).focus();
}

$('#tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const base = {
    amount: Number(f.amount.value),
    date: f.date.value,
    note: f.note.value.trim() || null,
    user_id: $('#tx-owner').dataset.value,
  };
  let table, row;
  if (state.kind === 'invest' || inKind()) {
    const { asset, unit } = currentAsset();
    if (!asset) return;
    table = 'investments';
    row = { ...base, kind: state.dir, asset, unit, quantity: Number(f.quantity.value), to_user_id: null };
    if (state.dir === 'transfer') Object.assign(row, { amount: 0, to_user_id: otherOf(base.user_id) });
    if (inKind()) Object.assign(row, { kind: 'income', amount: 0, category: state.category });
  } else {
    table = 'transactions';
    row = { ...base, kind: state.kind, category: state.category };
  }
  const q = state.editing
    ? sb.from(table).update(row).eq('id', state.editing.row.id)
    : sb.from(table).insert(row);
  const { error } = await q;
  if (error) return fail(error);
  $('#tx-dialog').close();
  toast('Kaydedildi');
  loadAll();
});

$('#tx-delete').addEventListener('click', async () => {
  if (!state.editing) return;
  const table = state.editing.type === 'inv' ? 'investments' : 'transactions';
  const { error } = await sb.from(table).delete().eq('id', state.editing.row.id);
  if (error) return fail(error);
  $('#tx-dialog').close();
  toast('Silindi');
  loadAll();
});

// ---------- beklenen gelirler (sadece not) ----------
$('#exp-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.expFilter = b.dataset.filter;
  $('#exp-filter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  renderExpected();
});

// Tik sadece "ödendi" notudur; gelirlere hiçbir şey eklemez.
$('#exp-groups').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const x = state.expected.find((r) => r.id === Number(li.dataset.id));
  if (e.target.matches('input[type=checkbox]')) {
    x.received = e.target.checked;
    renderExpected();
    toast(x.received ? 'Ödendi olarak işaretlendi' : 'Tekrar bekleyenlerde');
    const { error } = await sb.from('expected_incomes').update({ received: x.received }).eq('id', x.id);
    if (error) { fail(error); loadAll(); }
    return;
  }
  if (e.target.closest('.editable')) openExpDialog(x);
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
  renderOwner($('#exp-owner'), x?.user_id);
  $('#exp-delete').classList.toggle('hidden', !x);
  $('#exp-delete-plan').classList.toggle('hidden', !x?.plan_id);
  $('#exp-dialog').showModal();
}

$('#exp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const base = { source: f.source.value.trim(), note: f.note.value.trim() || null, user_id: $('#exp-owner').dataset.value };
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
