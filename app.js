// ============================================================
// TimeLedger — app.js
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
  throw new Error('TimeLedger: fill in config.js with your Firebase project keys before using the app.');
}

// ---- Firebase init -------------------------------------------------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;      // { uid, name, email, role }
let projectsCache = [];      // [{id, name, description, active}]
let allEntriesCache = [];
let filteredRows = [];
let userEntriesUnsub = null;
let allEntriesUnsub = null;
let editingEntryId = null;
let editingProjectId = null;

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
  }
});

function cleanupListeners() {
  if (userEntriesUnsub) { userEntriesUnsub(); userEntriesUnsub = null; }
  if (allEntriesUnsub) { allEntriesUnsub(); allEntriesUnsub = null; }
}

// ============================================================
// Projects
// ============================================================
function listenProjects() {
  db.collection('projects').orderBy('name').onSnapshot((snap) => {
    projectsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProjectSelect();
    if (currentUser.role === 'editor') {
      renderProjectsTable();
      renderFilterProjectSelect();
    }
  });
}

function renderProjectSelect() {
  const sel = $('entryProject');
  if (!sel) return;
  const active = projectsCache.filter(p => p.active !== false);
  const current = sel.value;
  sel.innerHTML = active.length
    ? active.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    : `<option value="">No active projects yet</option>`;
  if (active.some(p => p.id === current)) sel.value = current;
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
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No projects yet — create the first one above.</td></tr>`;
    return;
  }
  tbody.innerHTML = projectsCache.map(p => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.description || '')}</td>
      <td><span class="stamp-badge ${p.active === false ? 'stamp-badge-off' : ''}">${p.active === false ? 'Archived' : 'Active'}</span></td>
      <td class="row-actions">
        <button class="link-btn" data-edit-project="${p.id}">Edit</button>
        <button class="link-btn" data-toggle-project="${p.id}">${p.active === false ? 'Unarchive' : 'Archive'}</button>
      </td>
    </tr>
  `).join('');
}

$('newProjectBtn').addEventListener('click', () => {
  editingProjectId = null;
  $('projectId').value = '';
  $('projectName').value = '';
  $('projectDesc').value = '';
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
      name, description, active: true,
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

  if (editId) {
    const p = projectsCache.find(x => x.id === editId);
    editingProjectId = editId;
    $('projectId').value = editId;
    $('projectName').value = p.name;
    $('projectDesc').value = p.description || '';
    $('projectForm').classList.remove('hidden');
  }
  if (toggleId) {
    const p = projectsCache.find(x => x.id === toggleId);
    await db.collection('projects').doc(toggleId).update({ active: p.active === false ? true : false });
  }
});

// ============================================================
// User: log hours
// ============================================================
$('entryDate').valueAsDate = new Date();

$('entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const projectId = $('entryProject').value;
  const project = projectsCache.find(p => p.id === projectId);
  const date = $('entryDate').value;
  const hours = parseFloat($('entryHours').value);
  const note = $('entryNote').value.trim();

  if (!projectId || !date || !hours || hours <= 0) return;

  const payload = {
    userId: currentUser.uid,
    userName: currentUser.name,
    projectId,
    projectName: project ? project.name : '',
    date, hours, note
  };

  if (editingEntryId) {
    await db.collection('entries').doc(editingEntryId).update(payload);
  } else {
    payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('entries').add(payload);
  }

  const wasEditing = !!editingEntryId;
  resetEntryForm();
  showStamp(wasEditing ? 'Updated' : 'Logged');
});

$('cancelEditBtn').addEventListener('click', resetEntryForm);

function resetEntryForm() {
  editingEntryId = null;
  $('entryForm').reset();
  $('entryDate').valueAsDate = new Date();
  $('cancelEditBtn').classList.add('hidden');
}

function listenUserEntries() {
  userEntriesUnsub = db.collection('entries')
    .where('userId', '==', currentUser.uid)
    .onSnapshot((snap) => {
      const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => b.date.localeCompare(a.date));
      renderUserEntries(entries);
    });
}

function renderUserEntries(entries) {
  const tbody = $('userEntriesTable').querySelector('tbody');
  $('userEmptyState').classList.toggle('hidden', entries.length > 0);

  tbody.innerHTML = entries.map(en => `
    <tr>
      <td>${formatDate(en.date)}</td>
      <td>${escapeHtml(en.projectName)}</td>
      <td class="num">${en.hours}</td>
      <td class="note-cell">${escapeHtml(en.note || '')}</td>
      <td class="row-actions">
        <button class="link-btn" data-edit-entry="${en.id}">Edit</button>
        <button class="link-btn link-danger" data-delete-entry="${en.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  const ym = new Date().toISOString().slice(0, 7);
  const monthTotal = entries.filter(en => en.date.startsWith(ym)).reduce((s, en) => s + en.hours, 0);
  $('userMonthTotal').textContent = trimZeros(monthTotal);

  tbody.querySelectorAll('[data-edit-entry]').forEach(btn => {
    btn.addEventListener('click', () => {
      const en = entries.find(x => x.id === btn.dataset.editEntry);
      editingEntryId = en.id;
      $('entryProject').value = en.projectId;
      $('entryDate').value = en.date;
      $('entryHours').value = en.hours;
      $('entryNote').value = en.note || '';
      $('cancelEditBtn').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  tbody.querySelectorAll('[data-delete-entry]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Delete this entry?')) {
        await db.collection('entries').doc(btn.dataset.deleteEntry).delete();
      }
    });
  });
}

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
  a.download = `timeledger-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
