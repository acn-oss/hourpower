// ============================================================
// Hour Power — app.js
// You shouldn't need to edit this file. Project/account
// settings live in config.js.
// ============================================================

const $ = (id) => document.getElementById(id);

// ---- Setup check -------------------------------------------------
const setupNotice = $('setupNotice');
if (!firebaseConfig.apiKey || firebaseConfig.apiKey === 'YOUR_API_KEY') {
  setupNotice.classList.remove('hidden');
  document.querySelectorAll('#loginForm input, #loginForm button, #signupForm input, #signupForm button')
    .forEach(el => el.disabled = true);
  throw new Error('Hour Power: fill in config.js with your Firebase project keys before using the app.');
}

// ---- Firebase init -------------------------------------------------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;      // { uid, name, email, role }
let projectsCache = [];      // [{id, name, description, active, assignedUserIds}]
let userEntriesCache = [];   // current user's entries (all dates)
let allEntriesCache = [];
let allUsersCache = [];      // editor only: everyone except editors, for the access panel & rates
let ratesCache = {};         // editor only: { uid: {costRate, salesRate} }
let filteredRows = [];
let userEntriesUnsub = null;
let allEntriesUnsub = null;
let allUsersUnsub = null;
let ratesUnsub = null;
let editingProjectId = null;
let accessProjectId = null;
let weekStart = getMonday(new Date());

function isAdminEmail(email) {
  return ADMIN_EMAILS.map(e => e.toLowerCase()).includes((email || '').toLowerCase());
}

function showStamp(text) {
  const el = $('stamp');
  el.textContent = text;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('stamp-show'));
  setTimeout(() => {
    el.classList.remove('stamp-show');
    setTimeout(() => el.classList.add('hidden'), 200);
  }, 1300);
}

function formatDate(d) {
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sun ... 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d, n) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekRangeLabel(start) {
  const end = addDays(start, 6);
  const fmt = (d) => `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
  return `Week ${isoWeekNumber(start)} · ${fmt(start)} – ${fmt(end)}`;
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function csvSafe(s) {
  const str = String(s ?? '').replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

// ============================================================
// Auth screen
// ============================================================
const loginForm = $('loginForm');
const signupForm = $('signupForm');
const toggleBtn = $('toggleAuthMode');
let showingLogin = true;

toggleBtn.addEventListener('click', () => {
  showingLogin = !showingLogin;
  loginForm.classList.toggle('hidden', !showingLogin);
  signupForm.classList.toggle('hidden', showingLogin);
  toggleBtn.textContent = showingLogin ? 'Need an account? Create one' : 'Already have an account? Sign in';
  $('authError').classList.add('hidden');
});

function showAuthError(msg) {
  const el = $('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function friendlyAuthError(err) {
  const map = {
    'auth/email-already-in-use': "That email already has an account — try signing in instead.",
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/weak-password': 'Password needs to be at least 6 characters.',
    'auth/wrong-password': 'Wrong password.',
    'auth/user-not-found': 'No account with that email yet.',
    'auth/invalid-credential': 'Email or password is incorrect.'
  };
  return map[err.code] || err.message;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').classList.add('hidden');
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    showAuthError(friendlyAuthError(err));
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').classList.add('hidden');
  const name = $('signupName').value.trim();
  const email = $('signupEmail').value.trim();
  const password = $('signupPassword').value;
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    const role = isAdminEmail(email) ? 'editor' : 'user';
    await db.collection('users').doc(cred.user.uid).set({
      name, email, role,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    showAuthError(friendlyAuthError(err));
  }
});

$('logoutBtn').addEventListener('click', () => auth.signOut());

// ============================================================
// Auth state → route to the right view
// ============================================================
auth.onAuthStateChanged(async (user) => {
  cleanupListeners();

  if (!user) {
    currentUser = null;
    $('authScreen').classList.remove('hidden');
    $('appScreen').classList.add('hidden');
    return;
  }

  let userDoc = await db.collection('users').doc(user.uid).get();
  if (!userDoc.exists) {
    const role = isAdminEmail(user.email) ? 'editor' : 'user';
    await db.collection('users').doc(user.uid).set({
      name: user.displayName || user.email,
      email: user.email,
      role,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    userDoc = await db.collection('users').doc(user.uid).get();
  }

  const data = userDoc.data();
  currentUser = { uid: user.uid, name: data.name, email: data.email, role: data.role };

  $('authScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('whoami').textContent = `${currentUser.name}${currentUser.role === 'editor' ? ' · editor' : ''}`;

  $('userView').classList.toggle('hidden', currentUser.role !== 'user');
  $('editorView').classList.toggle('hidden', currentUser.role !== 'editor');

  listenProjects();
  if (currentUser.role === 'user') {
    listenUserEntries();
  } else {
    listenAllEntriesForEditor();
    listenAllUsers();
    listenRates();
  }
});

function cleanupListeners() {
  if (userEntriesUnsub) { userEntriesUnsub(); userEntriesUnsub = null; }
  if (allEntriesUnsub) { allEntriesUnsub(); allEntriesUnsub = null; }
  if (allUsersUnsub) { allUsersUnsub(); allUsersUnsub = null; }
  if (ratesUnsub) { ratesUnsub(); ratesUnsub = null; }
}

// ============================================================
// Projects
// ============================================================
function listenProjects() {
  db.collection('projects').orderBy('name').onSnapshot((snap) => {
    projectsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentUser.role === 'editor') {
      renderProjectsTable();
      renderFilterProjectSelect();
    } else {
      renderWeekGrid();
    }
  });
}

function isProjectVisibleToCurrentUser(p) {
  return !p.assignedUserIds || p.assignedUserIds.length === 0 || p.assignedUserIds.includes(currentUser.uid);
}

function projectLabelHtml(p) {
  return (p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : '') + escapeHtml(p.name);
}

function projectLabelText(p) {
  return (p.code ? `${p.code} — ` : '') + p.name;
}

function listenAllUsers() {
  allUsersUnsub = db.collection('users').orderBy('name').onSnapshot((snap) => {
    allUsersCache = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role !== 'editor');
    renderProjectsTable();
    renderRatesTable();
  });
}

function listenRates() {
  ratesUnsub = db.collection('rates').onSnapshot((snap) => {
    ratesCache = {};
    snap.docs.forEach(d => { ratesCache[d.id] = d.data(); });
    renderRatesTable();
    renderProjectTotals();
  });
}

function renderRatesTable() {
  const tbody = $('ratesTable').querySelector('tbody');
  if (!allUsersCache.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No one has signed up yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = allUsersCache.map(u => {
    const r = ratesCache[u.uid] || {};
    return `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td class="num"><input type="number" min="0" step="1" class="rate-input"
        data-rate-uid="${u.uid}" data-rate-field="costRate" value="${r.costRate ?? ''}" /></td>
      <td class="num"><input type="number" min="0" step="1" class="rate-input"
        data-rate-uid="${u.uid}" data-rate-field="salesRate" value="${r.salesRate ?? ''}" /></td>
    </tr>`;
  }).join('');
}

$('ratesTable').addEventListener('change', async (e) => {
  const input = e.target;
  if (!(input.matches && input.matches('input[data-rate-uid]'))) return;

  const uid = input.dataset.rateUid;
  const field = input.dataset.rateField;
  const raw = input.value.trim();
  if (raw !== '' && (isNaN(parseFloat(raw)) || parseFloat(raw) < 0)) {
    input.value = '';
    return;
  }
  const value = raw === '' ? 0 : parseFloat(raw);

  input.disabled = true;
  try {
    await db.collection('rates').doc(uid).set({ [field]: value }, { merge: true });
    showStamp('Saved');
  } finally {
    input.disabled = false;
  }
});

function formatDkk(n) {
  return n.toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' kr.';
}

function renderProjectTotals() {
  const projectId = $('totalsProjectSelect').value;
  const tbody = $('projectTotalsTable').querySelector('tbody');
  const tfoot = $('projectTotalsTable').querySelector('tfoot');

  if (!projectId) {
    $('totalsHint').classList.remove('hidden');
    $('totalsEmptyState').classList.add('hidden');
    $('projectTotalsTable').classList.add('hidden');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';
    return;
  }
  $('totalsHint').classList.add('hidden');

  const byUser = {};
  allEntriesCache.filter(en => en.projectId === projectId).forEach(en => {
    if (!byUser[en.userId]) byUser[en.userId] = { userName: en.userName, hours: 0 };
    byUser[en.userId].hours += en.hours;
  });

  const userIds = Object.keys(byUser).sort((a, b) => byUser[a].userName.localeCompare(byUser[b].userName));
  $('totalsEmptyState').classList.toggle('hidden', userIds.length > 0);
  $('projectTotalsTable').classList.toggle('hidden', userIds.length === 0);

  let totalHours = 0, totalCost = 0, totalSales = 0;
  tbody.innerHTML = userIds.map(uid => {
    const { userName, hours } = byUser[uid];
    const rate = ratesCache[uid] || {};
    const cost = hours * (rate.costRate || 0);
    const sales = hours * (rate.salesRate || 0);
    totalHours += hours; totalCost += cost; totalSales += sales;
    return `
    <tr>
      <td>${escapeHtml(userName)}</td>
      <td class="num">${trimZeros(hours)}</td>
      <td class="num">${formatDkk(cost)}</td>
      <td class="num">${formatDkk(sales)}</td>
      <td class="num">${formatDkk(sales - cost)}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `
    <tr class="totals-row">
      <td>Total</td>
      <td class="num">${trimZeros(totalHours)}</td>
      <td class="num">${formatDkk(totalCost)}</td>
      <td class="num">${formatDkk(totalSales)}</td>
      <td class="num">${formatDkk(totalSales - totalCost)}</td>
    </tr>`;
}

$('totalsProjectSelect').addEventListener('change', renderProjectTotals);

function renderFilterProjectSelect() {
  populateProjectSelect($('filterProject'), 'All projects');
  populateProjectSelect($('totalsProjectSelect'), 'Choose a project…');
}

function populateProjectSelect(sel, placeholder) {
  const current = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    projectsCache.map(p => `<option value="${p.id}">${escapeHtml(projectLabelText(p))}</option>`).join('');
  sel.value = current;
}

function renderProjectsTable() {
  const tbody = $('projectsTable').querySelector('tbody');
  if (!projectsCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No projects yet — create the first one above.</td></tr>`;
    return;
  }
  tbody.innerHTML = projectsCache.map(p => {
    const n = (p.assignedUserIds || []).length;
    return `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td class="num-col">${p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : ''}</td>
      <td>${escapeHtml(p.client || '')}</td>
      <td><span class="stamp-badge ${p.active === false ? 'stamp-badge-off' : ''}">${p.active === false ? 'Archived' : 'Active'}</span></td>
      <td>${n === 0 ? 'Everyone' : `${n} ${n === 1 ? 'person' : 'people'}`}</td>
      <td class="row-actions">
        <button class="link-btn" data-edit-project="${p.id}">Edit</button>
        <button class="link-btn" data-access-project="${p.id}">Access</button>
        <button class="link-btn" data-toggle-project="${p.id}">${p.active === false ? 'Unarchive' : 'Archive'}</button>
      </td>
    </tr>
  `;
  }).join('');
}

$('newProjectBtn').addEventListener('click', () => {
  editingProjectId = null;
  $('projectId').value = '';
  $('projectName').value = '';
  $('projectCode').value = '';
  $('projectClient').value = '';
  $('projectDesc').value = '';
  $('accessPanel').classList.add('hidden');
  $('projectForm').classList.remove('hidden');
  $('projectName').focus();
});

$('cancelProjectBtn').addEventListener('click', () => {
  $('projectForm').classList.add('hidden');
});

$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('projectName').value.trim();
  const code = $('projectCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const client = $('projectClient').value.trim();
  const description = $('projectDesc').value.trim();
  if (!name) return;
  $('projectCode').value = code;

  if (editingProjectId) {
    await db.collection('projects').doc(editingProjectId).update({ name, code, client, description });
  } else {
    await db.collection('projects').add({
      name, code, client, description, active: true, assignedUserIds: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    });
  }
  $('projectForm').classList.add('hidden');
  showStamp('Saved');
});

$('projectsTable').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editProject;
  const toggleId = e.target.dataset.toggleProject;
  const accessId = e.target.dataset.accessProject;

  if (editId) {
    const p = projectsCache.find(x => x.id === editId);
    editingProjectId = editId;
    $('projectId').value = editId;
    $('projectName').value = p.name;
    $('projectCode').value = p.code || '';
    $('projectClient').value = p.client || '';
    $('projectDesc').value = p.description || '';
    $('accessPanel').classList.add('hidden');
    $('projectForm').classList.remove('hidden');
  }
  if (toggleId) {
    const p = projectsCache.find(x => x.id === toggleId);
    await db.collection('projects').doc(toggleId).update({ active: p.active === false ? true : false });
  }
  if (accessId) {
    openAccessPanel(accessId);
  }
});

function openAccessPanel(projectId) {
  const p = projectsCache.find(x => x.id === projectId);
  accessProjectId = projectId;
  $('accessProjectName').textContent = p.name;
  const assigned = new Set(p.assignedUserIds || []);
  $('accessCheckboxes').innerHTML = allUsersCache.length
    ? allUsersCache.map(u => `
        <label class="checkbox-row">
          <input type="checkbox" value="${u.uid}" ${assigned.has(u.uid) ? 'checked' : ''} />
          ${escapeHtml(u.name)}
        </label>`).join('')
    : `<p class="empty-state">No one has signed up yet — once your team creates accounts, they'll show up here.</p>`;
  $('projectForm').classList.add('hidden');
  $('accessPanel').classList.remove('hidden');
}

$('saveAccessBtn').addEventListener('click', async () => {
  const checked = [...$('accessCheckboxes').querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
  await db.collection('projects').doc(accessProjectId).update({ assignedUserIds: checked });
  $('accessPanel').classList.add('hidden');
  showStamp('Saved');
});

$('cancelAccessBtn').addEventListener('click', () => $('accessPanel').classList.add('hidden'));

// ============================================================
// User: weekly hours grid
// ============================================================
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

$('weekPrevBtn').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderWeekGrid(); });
$('weekNextBtn').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderWeekGrid(); });
$('weekTodayBtn').addEventListener('click', () => { weekStart = getMonday(new Date()); renderWeekGrid(); });

function listenUserEntries() {
  userEntriesUnsub = db.collection('entries')
    .where('userId', '==', currentUser.uid)
    .onSnapshot((snap) => {
      userEntriesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderWeekGrid();
    });
}

function renderWeekGrid() {
  if (!currentUser || currentUser.role !== 'user') return;

  $('weekLabel').textContent = weekRangeLabel(weekStart);

  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dateStrs = weekDates.map(toISODate);

  $('weekGridHeadRow').innerHTML = '<th>Project</th>' +
    weekDates.map((d, i) => `<th class="num ${i >= 5 ? 'weekend' : ''}">${DAY_NAMES[i]}<span class="day-date">${d.getDate()}/${d.getMonth() + 1}</span></th>`).join('') +
    '<th class="num">Total</th>';

  const visibleProjects = projectsCache.filter(p => p.active !== false && isProjectVisibleToCurrentUser(p));
  const hasProjects = visibleProjects.length > 0;
  $('noProjectsState').classList.toggle('hidden', hasProjects);
  $('weekGridTable').classList.toggle('hidden', !hasProjects);

  const entryFor = (projectId, date) => userEntriesCache.find(en => en.projectId === projectId && en.date === date);

  $('weekGridBody').innerHTML = visibleProjects.map(p => {
    let rowTotal = 0;
    const cells = dateStrs.map((ds, i) => {
      const en = entryFor(p.id, ds);
      const hours = en ? en.hours : 0;
      rowTotal += hours;
      return `<td class="${i >= 5 ? 'weekend' : ''}"><input type="number" min="0" step="0.25" inputmode="decimal"
        data-project="${p.id}" data-date="${ds}" value="${en ? en.hours : ''}" /></td>`;
    }).join('');
    return `<tr><td>${projectLabelHtml(p)}</td>${cells}<td class="num row-total">${trimZeros(rowTotal)}</td></tr>`;
  }).join('');

  const dayTotals = dateStrs.map(ds =>
    visibleProjects.reduce((sum, p) => {
      const en = entryFor(p.id, ds);
      return sum + (en ? en.hours : 0);
    }, 0)
  );
  const grandTotal = dayTotals.reduce((s, n) => s + n, 0);
  $('weekGridFoot').innerHTML = `<tr class="totals-row"><td>Total</td>` +
    dayTotals.map((t, i) => `<td class="num ${i >= 5 ? 'weekend' : ''}">${trimZeros(t)}</td>`).join('') +
    `<td class="num">${trimZeros(grandTotal)}</td></tr>`;
}

$('weekGridBody').addEventListener('change', async (e) => {
  const input = e.target;
  if (!(input.matches && input.matches('input[data-project]'))) return;

  const projectId = input.dataset.project;
  const date = input.dataset.date;
  const raw = input.value.trim();

  if (raw !== '' && (isNaN(parseFloat(raw)) || parseFloat(raw) < 0)) {
    input.value = '';
    return;
  }
  const hours = raw === '' ? 0 : parseFloat(raw);
  const project = projectsCache.find(p => p.id === projectId);
  const existing = userEntriesCache.find(en => en.projectId === projectId && en.date === date);

  input.disabled = true;
  try {
    if (hours === 0) {
      if (existing) await db.collection('entries').doc(existing.id).delete();
    } else {
      const payload = {
        userId: currentUser.uid,
        userName: currentUser.name,
        projectId,
        projectName: project ? project.name : '',
        date,
        hours
      };
      if (existing) {
        await db.collection('entries').doc(existing.id).update(payload);
      } else {
        payload.note = '';
        payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('entries').add(payload);
      }
      showStamp('Saved');
    }
  } finally {
    input.disabled = false;
  }
});

function trimZeros(n) {
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}

// ============================================================
// Editor: all entries + filters + export
// ============================================================
function listenAllEntriesForEditor() {
  allEntriesUnsub = db.collection('entries').onSnapshot((snap) => {
    allEntriesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFilterUserSelect();
    renderAllEntries();
    renderProjectTotals();
  });
}

function renderFilterUserSelect() {
  const sel = $('filterUser');
  const current = sel.value;
  const names = [...new Map(allEntriesCache.map(e => [e.userId, e.userName])).entries()];
  sel.innerHTML = '<option value="">Everyone</option>' +
    names.map(([uid, name]) => `<option value="${uid}">${escapeHtml(name)}</option>`).join('');
  sel.value = current;
}

['filterProject', 'filterUser', 'filterFrom', 'filterTo'].forEach(id => {
  $(id).addEventListener('change', renderAllEntries);
});

function projectById(id) {
  return projectsCache.find(p => p.id === id);
}

function renderAllEntries() {
  const proj = $('filterProject').value;
  const user = $('filterUser').value;
  const from = $('filterFrom').value;
  const to = $('filterTo').value;

  filteredRows = allEntriesCache.filter(en => {
    if (proj && en.projectId !== proj) return false;
    if (user && en.userId !== user) return false;
    if (from && en.date < from) return false;
    if (to && en.date > to) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));

  const tbody = $('allEntriesTable').querySelector('tbody');
  $('allEmptyState').classList.toggle('hidden', filteredRows.length > 0);
  tbody.innerHTML = filteredRows.map(en => {
    const p = projectById(en.projectId);
    const codeBadge = p && p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : '';
    return `
    <tr>
      <td>${formatDate(en.date)}</td>
      <td>${escapeHtml(en.userName)}</td>
      <td>${codeBadge}${escapeHtml(en.projectName)}</td>
      <td>${escapeHtml(p ? (p.client || '') : '')}</td>
      <td class="num">${en.hours}</td>
      <td class="note-cell">${escapeHtml(en.note || '')}</td>
    </tr>
  `;
  }).join('');

  const total = filteredRows.reduce((s, en) => s + en.hours, 0);
  $('allEntriesTotal').textContent = trimZeros(total);
}

$('exportCsvBtn').addEventListener('click', () => {
  const header = ['Date', 'Person', 'Project', 'Project number', 'Client', 'Hours', 'Note'];
  const lines = [header.join(',')].concat(filteredRows.map(en => {
    const p = projectById(en.projectId);
    return [
      en.date, csvSafe(en.userName), csvSafe(en.projectName),
      csvSafe(p ? (p.code || '') : ''), csvSafe(p ? (p.client || '') : ''),
      en.hours, csvSafe(en.note || '')
    ].join(',');
  }));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hourpower-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
