import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EXPENSE_CATEGORIES = ['Market', 'Kira', 'Faturalar', 'Ulaşım', 'Yemek / Kafe', 'Sağlık', 'Giyim', 'Eğitim',
  'Eğlence', 'Ev eşyası', 'Kredi / Taksit', 'Sigorta', 'Hediye', 'Bakım / Kişisel', 'Diğer'];
const INCOME_CATEGORIES = ['Maaş', 'Prim / İkramiye', 'Ek iş', 'Kira geliri', 'Yatırım getirisi', 'Diğer'];
const ASSET_TYPES = ['Altın', 'Döviz', 'Hisse senedi', 'Yatırım fonu', 'Mevduat / Vadeli', 'Kripto', 'BES', 'Gayrimenkul', 'Diğer'];

const state = {
  user: null,
  profiles: {},          // id -> display_name
  transactions: [],
  investments: [],
  shopping: [],
  month: startOfMonth(new Date()),
  tab: 'summary',
  txFilter: 'all',
  editingTx: null,
  editingInv: null,
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

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const [p, t, i, s] = await Promise.all([
    sb.from('profiles').select('id, display_name'),
    sb.from('transactions').select('*').order('date', { ascending: false }).order('id', { ascending: false }),
    sb.from('investments').select('*').order('date', { ascending: false }).order('id', { ascending: false }),
    sb.from('shopping_items').select('*').order('checked').order('created_at', { ascending: false }),
  ]);
  for (const r of [p, t, i, s]) if (r.error) return fail(r.error);
  state.profiles = Object.fromEntries(p.data.map((x) => [x.id, x.display_name]));
  state.transactions = t.data;
  state.investments = i.data;
  state.shopping = s.data;
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
  renderShopping();
}

function inMonth(rows, month = state.month) {
  const key = monthKey(month);
  return rows.filter((r) => r.date.startsWith(key));
}

function renderSummary() {
  const tx = inMonth(state.transactions);
  const inv = inMonth(state.investments);
  const income = sum(tx.filter((t) => t.kind === 'income'), (t) => t.amount);
  const expense = sum(tx.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const net = income - expense;
  const invested = sum(inv, (x) => x.amount);

  $('#sum-income').textContent = fmt(income);
  $('#sum-expense').textContent = fmt(expense);
  $('#sum-net').textContent = fmt(net);
  $('#sum-net').classList.toggle('negative', net < 0);
  $('#sum-rate').textContent = income > 0 ? `Gelirin %${Math.round((net / income) * 100)}'i` : '';
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
    return { m, inc, exp, net: inc - exp };
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
  const allInv = sum(state.investments, (x) => x.amount);
  $('#all-net').textContent = fmt(allInc - allExp);
  $('#all-invest').textContent = fmt(allInv);
  const byAsset = {};
  for (const x of state.investments) byAsset[x.asset_type] = (byAsset[x.asset_type] || 0) + Number(x.amount);
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
  const rows = filterByOwner(inMonth(state.transactions));
  $('#tx-empty').classList.toggle('hidden', rows.length > 0);
  $('#tx-list').innerHTML = rows.map((t) => `
    <li class="item ${isMe(t.user_id) ? 'editable' : ''}" data-id="${t.id}">
      <div class="item-main">
        <div class="item-title">${esc(t.category)}${t.note ? ` <span class="muted">· ${esc(t.note)}</span>` : ''}</div>
        <div class="item-sub">${dayFmt.format(parseDate(t.date))} ${ownerBadge(t.user_id)}</div>
      </div>
      <div class="amount ${t.kind}">${t.kind === 'income' ? '+' : '−'}${fmt(t.amount)}</div>
    </li>`).join('');
}

function renderInvestments() {
  const rows = inMonth(state.investments);
  $('#inv-month-total').textContent = fmt(sum(rows, (x) => x.amount));
  $('#inv-empty').classList.toggle('hidden', rows.length > 0);
  $('#inv-list').innerHTML = rows.map((x) => `
    <li class="item ${isMe(x.user_id) ? 'editable' : ''}" data-id="${x.id}">
      <div class="item-main">
        <div class="item-title">${esc(x.asset_type)}${x.description ? ` <span class="muted">· ${esc(x.description)}</span>` : ''}</div>
        <div class="item-sub">${dayFmt.format(parseDate(x.date))}${x.quantity ? ` · ${Number(x.quantity).toLocaleString('tr-TR')} adet/birim` : ''} ${ownerBadge(x.user_id)}</div>
      </div>
      <div class="amount invest">${fmt(x.amount)}</div>
    </li>`).join('');
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
  $('.month-nav').classList.toggle('invisible', state.tab === 'shopping');
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
  if (state.tab === 'investments') openInvDialog(null); else openTxDialog(null);
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

function openTxDialog(tx) {
  state.editingTx = tx;
  const f = $('#tx-form');
  f.reset();
  $('#tx-title').textContent = tx ? 'Kaydı düzenle' : 'Yeni kayıt';
  $('#tx-delete').classList.toggle('hidden', !tx);
  setTxKind(tx?.kind || 'expense', tx?.category);
  f.amount.value = tx?.amount ?? '';
  f.date.value = tx?.date ?? defaultDate();
  f.note.value = tx?.note ?? '';
  $('#tx-dialog').showModal();
}

$('#tx-list').addEventListener('click', (e) => {
  const li = e.target.closest('li.editable');
  if (li) openTxDialog(state.transactions.find((t) => t.id === Number(li.dataset.id)));
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

function openInvDialog(inv) {
  state.editingInv = inv;
  const f = $('#inv-form');
  f.reset();
  $('#inv-title').textContent = inv ? 'Yatırımı düzenle' : 'Yeni yatırım';
  $('#inv-delete').classList.toggle('hidden', !inv);
  f.asset_type.value = inv?.asset_type ?? ASSET_TYPES[0];
  f.amount.value = inv?.amount ?? '';
  f.quantity.value = inv?.quantity ?? '';
  f.description.value = inv?.description ?? '';
  f.date.value = inv?.date ?? defaultDate();
  $('#inv-dialog').showModal();
}

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
    description: f.description.value.trim() || null,
    date: f.date.value,
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
