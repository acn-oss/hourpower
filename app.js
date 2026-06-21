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
let allUsersCache = [];      // editor only: everyone except editors, for the access panel
let filteredRows = [];
let userEntriesUnsub = null;
let allEntriesUnsub = null;
let allUsersUnsub = null;
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
  return `${fmt(start)} – ${fmt(end)}`;
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
  }
});

function cleanupListeners() {
  if (userEntriesUnsub) { userEntriesUnsub(); userEntriesUnsub = null; }
  if (allEntriesUnsub) { allEntriesUnsub(); allEntriesUnsub = null; }
  if (allUsersUnsub) { allUsersUnsub(); allUsersUnsub = null; }
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

function listenAllUsers() {
  allUsersUnsub = db.collection('users').orderBy('name').onSnapshot((snap) => {
    allUsersCache = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role !== 'editor');
    renderProjectsTable();
  });
}

function renderFilterProjectSelect() {
  const sel = $('filterProject');
  const current = sel.value;
  sel.innerHTML = '<option value="">All projects</option>' +
    projectsCache.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  sel.value = current;
}

function renderProjectsTable() {
  const tbody = $('projectsTable').querySelector('tbody');
  if (!projectsCache.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No projects yet — create the first one above.</td></tr>`;
    return;
  }
  tbody.innerHTML = projectsCache.map(p => {
    const n = (p.assignedUserIds || []).length;
    return `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.description || '')}</td>
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
  const description = $('projectDesc').value.trim();
  if (!name) return;

  if (editingProjectId) {
    await db.collection('projects').doc(editingProjectId).update({ name, description });
  } else {
    await db.collection('projects').add({
      name, description, active: true, assignedUserIds: [],
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
    return `<tr><td>${escapeHtml(p.name)}</td>${cells}<td class="num row-total">${trimZeros(rowTotal)}</td></tr>`;
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
  tbody.innerHTML = filteredRows.map(en => `
    <tr>
      <td>${formatDate(en.date)}</td>
      <td>${escapeHtml(en.userName)}</td>
      <td>${escapeHtml(en.projectName)}</td>
      <td class="num">${en.hours}</td>
      <td class="note-cell">${escapeHtml(en.note || '')}</td>
    </tr>
  `).join('');

  const total = filteredRows.reduce((s, en) => s + en.hours, 0);
  $('allEntriesTotal').textContent = trimZeros(total);
}

$('exportCsvBtn').addEventListener('click', () => {
  const header = ['Date', 'Person', 'Project', 'Hours', 'Note'];
  const lines = [header.join(',')].concat(filteredRows.map(en => [
    en.date, csvSafe(en.userName), csvSafe(en.projectName), en.hours, csvSafe(en.note || '')
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hourpower-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
