// ============================================================
// Hour Power — app.js
// You shouldn't need to edit this file. Project/account
// settings live in config.js.
// ============================================================

// Show the last-modified date of this file in the page footer.
// Updates automatically whenever app.js is re-uploaded to GitHub.
(async () => {
  try {
    const res = await fetch('app.js', { method: 'HEAD', cache: 'no-cache' });
    const lastMod = res.headers.get('last-modified');
    const el = document.getElementById('appUpdateNotice');
    if (el && lastMod) {
      const d = new Date(lastMod);
      const formatted = d.toLocaleString('da-DK', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      el.textContent = `Last app update: ${formatted}`;
    }
  } catch { /* silently ignore if fetch fails */ }
})();

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
let projectsCache = [];
let userEntriesCache = [];
let allEntriesCache = [];
let allUsersCache = [];
let archivedUsersCache = [];
let ratesCache = {};
let filteredRows = [];
let userEntriesUnsub = null;
let allEntriesUnsub = null;
let allUsersUnsub = null;
let ratesUnsub = null;
let editingProjectId = null;
let accessProjectId = null;
let projectSortKey = 'code';
let projectSortDir = 'desc';
let weekStart = getMonday(new Date());
let editorWeekStart = getMonday(new Date());
let userSortKey = 'code';
let userSortDir = 'desc';

// Generic extra-type system (ADM, AQ, INT — all stored in the projects collection with a type field)
const EXTRA_TYPES = [
  { type: 'adm', label: 'ADM' },
  { type: 'aq',  label: 'AQ'  },
  { type: 'int', label: 'INT' }
];
let extraCache = { adm: [], aq: [], int: [] };
let currentExtraEdit   = { type: null, id: null };
let currentExtraAccess = { type: null, id: null };

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
let showingLogin = true;

$('toggleAuthMode').addEventListener('click', () => {
  showingLogin = !showingLogin;
  loginForm.classList.toggle('hidden', !showingLogin);
  signupForm.classList.toggle('hidden', showingLogin);
  $('toggleAuthMode').textContent = showingLogin ? 'Need an account? Create one' : 'Already have an account? Sign in';
  $('authError').classList.add('hidden');
});

const ALLOWED_DOMAIN = 'urbanpower.dk';

function showAuthError(msg) {
  const el = $('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function friendlyAuthError(err) {
  const map = {
    'auth/email-already-in-use': "That email already has an account — try signing in instead.",
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/weak-password': 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character (e.g. !, @, #).',
    'auth/wrong-password': 'Wrong password.',
    'auth/user-not-found': 'No account with that email yet.',
    'auth/invalid-credential': 'Email or password is incorrect.'
  };
  return map[err.code] || err.message;
}

$('forgotPasswordBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const msg = $('forgotMsg');
  if (!email) {
    msg.innerHTML = '⚠ Enter your email address in the field above first.';
    msg.style.color = 'var(--stamp)';
    msg.classList.remove('hidden');
    return;
  }
  try {
    await auth.sendPasswordResetEmail(email);
    msg.innerHTML = `✓ Reset link sent to <strong>${escapeHtml(email)}</strong>.<br>
      Check your inbox — and if you don't see it within a minute or two, <strong>check your spam or junk folder</strong>.`;
    msg.style.color = 'var(--accent-dark)';
    $('forgotPasswordBtn').classList.add('hidden');
  } catch (err) {
    msg.innerHTML = err.code === 'auth/user-not-found'
      ? '⚠ No account found with that email address.'
      : `⚠ ${escapeHtml(err.message)}`;
    msg.style.color = 'var(--danger)';
  }
  msg.classList.remove('hidden');
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').classList.add('hidden');
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    showAuthError(friendlyAuthError(err));
    // Reveal the forgot-password link after the first failed attempt
    $('forgotPasswordBtn').classList.remove('hidden');
    $('forgotMsg').classList.add('hidden');
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').classList.add('hidden');
  const name = $('signupName').value.trim();
  const email = $('signupEmail').value.trim().toLowerCase();
  const password = $('signupPassword').value;

  // Enforce domain
  if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
    showAuthError(`Only @${ALLOWED_DOMAIN} email addresses can sign up.`);
    return;
  }

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    // Always role: user — editors are promoted manually in Firestore
    await db.collection('users').doc(cred.user.uid).set({
      name, email, role: 'user',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    showAuthError(friendlyAuthError(err));
  }
});

$('logoutBtn').addEventListener('click', () => auth.signOut());
$('verifyLogoutBtn').addEventListener('click', () => auth.signOut());

$('resendVerifyBtn').addEventListener('click', async () => {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await user.sendEmailVerification();
    $('verifyError').classList.add('hidden');
    $('resendVerifyBtn').textContent = 'Email sent ✓';
    $('resendVerifyBtn').disabled = true;
    setTimeout(() => {
      $('resendVerifyBtn').textContent = 'Resend verification email';
      $('resendVerifyBtn').disabled = false;
    }, 30000);
  } catch (err) {
    const el = $('verifyError');
    el.textContent = err.code === 'auth/too-many-requests'
      ? 'Please wait a moment before requesting another email.'
      : err.message;
    el.classList.remove('hidden');
  }
});

// ============================================================
// Auth state → route to the right view
// ============================================================
auth.onAuthStateChanged(async (user) => {
  cleanupListeners();

  if (!user) {
    currentUser = null;
    $('authScreen').classList.remove('hidden');
    $('verifyScreen').classList.add('hidden');
    $('appScreen').classList.add('hidden');
    return;
  }

  // Block unverified accounts — send them a verification email first
  if (!user.emailVerified) {
    $('authScreen').classList.add('hidden');
    $('verifyScreen').classList.remove('hidden');
    $('appScreen').classList.add('hidden');
    $('verifyEmail').textContent = user.email;
    try {
      await user.sendEmailVerification();
    } catch (err) {
      // Don't throw — they may have already been sent one recently (rate limited)
      if (err.code !== 'auth/too-many-requests') console.warn('sendEmailVerification:', err.message);
    }
    return;
  }

  let userDoc = await db.collection('users').doc(user.uid).get();
  if (!userDoc.exists) {
    // New account created by the editor in Firebase Console — default role is user.
    // To promote someone to editor, update their role field in Firestore Console.
    await db.collection('users').doc(user.uid).set({
      name: user.displayName || user.email,
      email: user.email,
      role: 'user',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    userDoc = await db.collection('users').doc(user.uid).get();
  }

  const data = userDoc.data();
  currentUser = { uid: user.uid, name: data.name, email: data.email, role: data.role };

  $('authScreen').classList.add('hidden');
  $('verifyScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('whoami').textContent = `${currentUser.name}${currentUser.role === 'editor' ? ' · editor' : ''}`;

  $('userView').classList.toggle('hidden', currentUser.role !== 'user');
  $('editorView').classList.toggle('hidden', currentUser.role !== 'editor');

  listenProjects();
  if (currentUser.role === 'user') {
    listenUserEntries();
  } else {
    initExtraTypeCards();
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
  db.collection('projects').onSnapshot((snap) => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    all.sort(compareProjectsByCodeDesc);
    projectsCache = all.filter(p => (p.type || 'project') === 'project');
    EXTRA_TYPES.forEach(({ type }) => {
      extraCache[type] = all.filter(p => p.type === type);
    });
    if (currentUser.role === 'editor') {
      renderProjectsTable();
      EXTRA_TYPES.forEach(({ type }) => renderExtraTable(type));
      renderFilterProjectSelect();
    } else {
      renderWeekGrid();
    }
  });
}

// Highest project number first (e.g. P301 above P299). Falls back to name
// when codes match or are missing, so uncoded projects still sort sensibly.
function compareProjectsByCodeDesc(a, b) {
  const codeA = a.code || '';
  const codeB = b.code || '';
  if (codeA && codeB) return codeA.localeCompare(codeB);
  if (codeA) return -1; // coded items first
  if (codeB) return 1;
  return (a.name || '').localeCompare(b.name || '');
}

// Compares strings the way a person would: "P2" < "P12" < "P301", not lexicographically.
function naturalCompare(a, b) {
  const aParts = a.match(/(\d+|\D+)/g) || [];
  const bParts = b.match(/(\d+|\D+)/g) || [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] || '';
    const bp = bParts[i] || '';
    if (/^\d+$/.test(ap) && /^\d+$/.test(bp)) {
      const diff = parseInt(ap, 10) - parseInt(bp, 10);
      if (diff !== 0) return diff;
    } else {
      const cmp = ap.localeCompare(bp);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
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
    const all = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role !== 'editor');
    allUsersCache = all.filter(u => u.active !== false);
    archivedUsersCache = all.filter(u => u.active === false);
    renderProjectsTable();
    EXTRA_TYPES.forEach(({ type }) => renderExtraTable(type));
    renderRatesTable();
    renderArchivedUsersTable();
    renderWeekOverview();
  });
}

// ============================================================
// Editor: weekly overview — flags employees with zero hours
// ============================================================
$('editorWeekPrevBtn').addEventListener('click', () => { editorWeekStart = addDays(editorWeekStart, -7); renderWeekOverview(); });
$('editorWeekNextBtn').addEventListener('click', () => { editorWeekStart = addDays(editorWeekStart, 7); renderWeekOverview(); });
$('editorWeekTodayBtn').addEventListener('click', () => { editorWeekStart = getMonday(new Date()); renderWeekOverview(); });

function renderWeekOverview() {
  const weekEnd = addDays(editorWeekStart, 6);
  const startStr = toISODate(editorWeekStart);
  const endStr = toISODate(weekEnd);
  $('editorWeekLabel').textContent = `Week ${isoWeekNumber(editorWeekStart)} · ${weekRangeLabel(editorWeekStart)}`;

  const tbody = $('weekOverviewTable').querySelector('tbody');
  $('weekOverviewEmpty').classList.toggle('hidden', allUsersCache.length > 0);
  $('weekOverviewTable').classList.toggle('hidden', allUsersCache.length === 0);

  // Sum hours per user for this week
  const hoursByUser = {};
  allEntriesCache.forEach(en => {
    if (en.date >= startStr && en.date <= endStr) {
      hoursByUser[en.userId] = (hoursByUser[en.userId] || 0) + en.hours;
    }
  });

  tbody.innerHTML = allUsersCache.map(u => {
    const hours = hoursByUser[u.uid] || 0;
    const status = hours > 0
      ? `<span class="status-ok">✓ ${trimZeros(hours)}h logged</span>`
      : `<span class="status-warn">⚠ No hours logged</span>`;
    return `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td class="num">${hours > 0 ? trimZeros(hours) : '–'}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}

function listenRates() {
  ratesUnsub = db.collection('rates').onSnapshot((snap) => {
    ratesCache = {};
    snap.docs.forEach(d => { ratesCache[d.id] = d.data(); });
    renderRatesTable();
    renderProjectTotals();
  }, (err) => {
    console.error('rates listener error:', err);
    if (err.code === 'permission-denied') {
      alert(
        "Can't load employee rates — Firestore is denying access.\n\n" +
        "Repaste firestore.rules into Firebase Console → Databases & Storage → Firestore → Rules → Publish, then refresh this page."
      );
    }
  });
}

function renderRatesTable() {
  const tbody = $('ratesTable').querySelector('tbody');
  if (!allUsersCache.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No active employees yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = allUsersCache.map(u => {
    const r = ratesCache[u.uid] || {};
    return `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td class="num"><input type="number" min="0" step="1" class="rate-input"
        data-rate-uid="${u.uid}" data-rate-field="salesRate" value="${r.salesRate ?? ''}" /></td>
      <td class="num"><input type="number" min="0" step="1" class="rate-input"
        data-rate-uid="${u.uid}" data-rate-field="costRate" value="${r.costRate ?? ''}" /></td>
      <td class="row-actions">
        <button class="link-btn" data-archive-user="${u.uid}">Archive</button>
        <button class="link-btn link-danger" data-delete-user-active="${u.uid}">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function renderArchivedUsersTable() {
  const tbody = $('archivedUsersTable').querySelector('tbody');
  $('archivedUsersEmpty').classList.toggle('hidden', archivedUsersCache.length > 0);
  $('archivedUsersTable').classList.toggle('hidden', archivedUsersCache.length === 0);
  tbody.innerHTML = archivedUsersCache.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email || '')}</td>
      <td class="row-actions">
        <button class="link-btn" data-unarchive-user="${u.uid}">Unarchive</button>
        <button class="link-btn link-danger" data-delete-user="${u.uid}">Delete</button>
      </td>
    </tr>`).join('');
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
  } catch (err) {
    alert(
      "That rate didn't save.\n\n" +
      (err.code === 'permission-denied'
        ? "This usually means the Firestore security rules haven't been updated yet for the rates feature — repaste firestore.rules into Firebase Console → Databases & Storage → Firestore → Rules → Publish."
        : err.message)
    );
    input.value = '';
  } finally {
    input.disabled = false;
  }
});

function formatDkk(n) {
  return n.toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' kr.';
}

function resolveProjectRate(project, dateStr, uid) {
  const standard = ratesCache[uid] || {};
  const lines = (project && project.rateLines) || [];

  let applicable = null;
  for (const line of lines) {
    if (line.usedFrom <= dateStr && (!applicable || line.usedFrom > applicable.usedFrom)) {
      applicable = line;
    }
  }

  const salesRate = (applicable && applicable.salesRate != null) ? applicable.salesRate : (standard.salesRate || 0);
  const costRate = (applicable && applicable.costRate != null) ? applicable.costRate : (standard.costRate || 0);
  return { salesRate, costRate };
}

function renderProjectTotals() {
  const projectId = $('totalsProjectSelect').value;
  const tbody = $('projectTotalsTable').querySelector('tbody');
  const tfoot = $('projectTotalsTable').querySelector('tfoot');

  if (!projectId) {
    $('totalsHint').classList.remove('hidden');
    $('totalsEmptyState').classList.add('hidden');
    $('projectTotalsTable').classList.add('hidden');
    $('projectSummary').classList.add('hidden');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';
    return;
  }
  $('totalsHint').classList.add('hidden');

  const project = projectById(projectId);
  const byUser = {};
  allEntriesCache.filter(en => en.projectId === projectId).forEach(en => {
    if (!byUser[en.userId]) byUser[en.userId] = { userName: en.userName, hours: 0, cost: 0, sales: 0 };
    const { salesRate, costRate } = resolveProjectRate(project, en.date, en.userId);
    byUser[en.userId].hours += en.hours;
    byUser[en.userId].cost += en.hours * costRate;
    byUser[en.userId].sales += en.hours * salesRate;
  });

  const userIds = Object.keys(byUser).sort((a, b) => byUser[a].userName.localeCompare(byUser[b].userName));
  $('totalsEmptyState').classList.toggle('hidden', userIds.length > 0);
  $('projectTotalsTable').classList.toggle('hidden', userIds.length === 0);

  let totalHours = 0, totalCost = 0, totalSales = 0;
  tbody.innerHTML = userIds.map(uid => {
    const { userName, hours, cost, sales } = byUser[uid];
    totalHours += hours; totalCost += cost; totalSales += sales;
    return `
    <tr>
      <td>${escapeHtml(userName)}</td>
      <td class="num">${trimZeros(hours)}</td>
      <td class="num">${formatDkk(sales)}</td>
      <td class="num">${formatDkk(cost)}</td>
      <td class="num">${formatDkk(sales - cost)}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `
    <tr class="totals-row">
      <td>Total</td>
      <td class="num">${trimZeros(totalHours)}</td>
      <td class="num">${formatDkk(totalSales)}</td>
      <td class="num">${formatDkk(totalCost)}</td>
      <td class="num">${formatDkk(totalSales - totalCost)}</td>
    </tr>`;

  // Project-level fee summary: expected fee, subadvisors, net fee, margin, factor
  const expectedFee = (project && project.expectedFee) || 0;
  const subadvisors = (project && project.subadvisors) || 0;
  const netFee = expectedFee - subadvisors;
  const margin = netFee - totalCost;
  const factor = totalCost > 0 ? (netFee / totalCost) : null;

  $('projectSummary').classList.remove('hidden');
  $('sumExpectedFee').textContent = formatDkk(expectedFee);
  $('sumSubadvisors').textContent = formatDkk(subadvisors);
  $('sumNetFee').textContent = formatDkk(netFee);
  $('sumCostPrice').textContent = formatDkk(totalCost);
  $('sumMargin').textContent = formatDkk(margin);
  $('sumFactor').textContent = factor === null ? '—' : `${factor.toFixed(1)}x`;
}

$('totalsProjectSelect').addEventListener('change', renderProjectTotals);

function renderFilterProjectSelect() {
  const filterSel = $('filterProject');
  const filterCurrent = filterSel.value;
  filterSel.innerHTML = '<option value="">All items</option>';
  EXTRA_TYPES.forEach(({ type, label }) => {
    if (extraCache[type].length) {
      filterSel.innerHTML += `<optgroup label="${label}">${extraCache[type].map(p =>
        `<option value="${p.id}">${escapeHtml(projectLabelText(p))}</option>`).join('')}</optgroup>`;
    }
  });
  if (projectsCache.length) {
    filterSel.innerHTML += `<optgroup label="Projects">${projectsCache.map(p =>
      `<option value="${p.id}">${escapeHtml(projectLabelText(p))}</option>`).join('')}</optgroup>`;
  }
  filterSel.value = filterCurrent;

  const totalsSel = $('totalsProjectSelect');
  const totalsCurrent = totalsSel.value;
  totalsSel.innerHTML = '<option value="">Choose a project…</option>' +
    projectsCache.map(p => `<option value="${p.id}">${escapeHtml(projectLabelText(p))}</option>`).join('');
  totalsSel.value = totalsCurrent;
}

function renderProjectsTable() {
  const tbody = $('projectsTable').querySelector('tbody');
  const thead = $('projectsTable').querySelector('thead tr');

  // Render clickable headers with sort indicators
  const cols = [
    { key: 'code',    label: 'No.'        },
    { key: 'name',    label: 'Project'    },
    { key: 'client',  label: 'Client'     },
    { key: 'visible', label: 'Visible to' }
  ];
  thead.innerHTML = cols.map(({ key, label }) => {
    const active = projectSortKey === key;
    const arrow = active ? (projectSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable-th${active ? ' sort-active' : ''}" data-sort-key="${key}">${label}${arrow}</th>`;
  }).join('') + '<th></th>';

  const active = projectsCache.filter(p => p.active !== false);

  // Sort by selected column — 'visible' sorts by number of assigned users
  active.sort((a, b) => {
    let cmp;
    if (projectSortKey === 'visible') {
      const nA = (a.assignedUserIds || []).length;
      const nB = (b.assignedUserIds || []).length;
      cmp = nA - nB;
    } else {
      const valA = (a[projectSortKey] || '').toLowerCase();
      const valB = (b[projectSortKey] || '').toLowerCase();
      cmp = valA.localeCompare(valB);
    }
    return projectSortDir === 'asc' ? cmp : -cmp;
  });

  if (!active.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No projects yet — create the first one above.</td></tr>`;
    renderArchivedProjectsTable();
    return;
  }
  tbody.innerHTML = active.map(p => {
    const n = (p.assignedUserIds || []).length;
    return `
    <tr>
      <td class="num-col">${p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : ''}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client || '')}</td>
      <td>${n === 0 ? 'Everyone' : `${n} ${n === 1 ? 'person' : 'people'}`}</td>
      <td class="row-actions">
        <button class="link-btn" data-edit-project="${p.id}">Edit</button>
        <button class="link-btn" data-access-project="${p.id}">Access</button>
        <button class="link-btn" data-toggle-project="${p.id}">Archive</button>
      </td>
    </tr>`;
  }).join('');
  renderArchivedProjectsTable();
}

function renderArchivedProjectsTable() {
  const archived = projectsCache.filter(p => p.active === false);
  const tbody = $('archivedTable').querySelector('tbody');
  $('archivedEmpty').classList.toggle('hidden', archived.length > 0);
  $('archivedTable').classList.toggle('hidden', archived.length === 0);
  tbody.innerHTML = archived.map(p => `
    <tr>
      <td class="num-col">${p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : ''}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client || '')}</td>
      <td class="row-actions">
        <button class="link-btn" data-unarchive-project="${p.id}">Unarchive</button>
        <button class="link-btn link-danger" data-delete-project="${p.id}">Delete</button>
      </td>
    </tr>`).join('');
}

$('newProjectBtn').addEventListener('click', () => {
  editingProjectId = null;
  $('projectId').value = '';
  $('projectName').value = '';
  $('projectCode').value = '';
  $('projectClient').value = '';
  $('projectDesc').value = '';
  $('projectExpectedFee').value = '';
  $('projectSubadvisors').value = '';
  clearRateLineInputs();
  $('accessPanel').classList.add('hidden');
  $('projectForm').classList.remove('hidden');
  $('projectName').focus();
});

const RATE_LINE_COUNT = 5;

function clearRateLineInputs() {
  for (let i = 0; i < RATE_LINE_COUNT; i++) {
    $(`rateLineDate${i}`).value = '';
    $(`rateLineSales${i}`).value = '';
    $(`rateLineCost${i}`).value = '';
  }
}

function fillRateLineInputs(rateLines) {
  clearRateLineInputs();
  (rateLines || []).slice(0, RATE_LINE_COUNT).forEach((line, i) => {
    $(`rateLineDate${i}`).value = line.usedFrom || '';
    $(`rateLineSales${i}`).value = line.salesRate != null ? line.salesRate : '';
    $(`rateLineCost${i}`).value = line.costRate != null ? line.costRate : '';
  });
}

function readRateLineInputs() {
  const lines = [];
  for (let i = 0; i < RATE_LINE_COUNT; i++) {
    const usedFrom = $(`rateLineDate${i}`).value;
    if (!usedFrom) continue;
    const salesRaw = $(`rateLineSales${i}`).value.trim();
    const costRaw = $(`rateLineCost${i}`).value.trim();
    const salesRate = (salesRaw !== '' && !isNaN(parseFloat(salesRaw)) && parseFloat(salesRaw) >= 0) ? parseFloat(salesRaw) : null;
    const costRate = (costRaw !== '' && !isNaN(parseFloat(costRaw)) && parseFloat(costRaw) >= 0) ? parseFloat(costRaw) : null;
    lines.push({ usedFrom, salesRate, costRate });
  }
  lines.sort((a, b) => a.usedFrom.localeCompare(b.usedFrom));
  return lines;
}

$('cancelProjectBtn').addEventListener('click', () => {
  $('projectForm').classList.add('hidden');
});

$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('projectName').value.trim();
  const code = $('projectCode').value.trim().slice(0, 10);
  const client = $('projectClient').value.trim();
  const description = $('projectDesc').value.trim();
  const expectedFee = parseNonNegative($('projectExpectedFee').value);
  const subadvisors = parseNonNegative($('projectSubadvisors').value);
  const rateLines = readRateLineInputs();
  if (!name) return;

  if (editingProjectId) {
    await db.collection('projects').doc(editingProjectId)
      .update({ name, code, client, description, expectedFee, subadvisors, rateLines });
  } else {
    await db.collection('projects').add({
      name, code, client, description, expectedFee, subadvisors, rateLines,
      active: true, assignedUserIds: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    });
  }
  $('projectForm').classList.add('hidden');
  showStamp('Saved');
});

function parseNonNegative(raw) {
  const v = parseFloat(String(raw).trim());
  return (!isNaN(v) && v >= 0) ? v : 0;
}

$('projectsTable').querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('[data-sort-key]');
  if (!th) return;
  const key = th.dataset.sortKey;
  if (projectSortKey === key) {
    projectSortDir = projectSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    projectSortKey = key;
    projectSortDir = 'asc';
  }
  renderProjectsTable();
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
    $('projectExpectedFee').value = p.expectedFee || '';
    $('projectSubadvisors').value = p.subadvisors || '';
    fillRateLineInputs(p.rateLines);
    $('accessPanel').classList.add('hidden');
    $('projectForm').classList.remove('hidden');
  }
  if (toggleId) {
    await db.collection('projects').doc(toggleId).update({ active: false });
  }
  if (accessId) {
    openAccessPanel(accessId);
  }
});

$('archivedTable').addEventListener('click', async (e) => {
  const unarchiveId = e.target.dataset.unarchiveProject;
  const deleteId = e.target.dataset.deleteProject;

  if (unarchiveId) {
    await db.collection('projects').doc(unarchiveId).update({ active: true });
  }
  if (deleteId) {
    const p = projectsCache.find(x => x.id === deleteId);
    const name = p ? `"${p.name}"` : 'this project';
    if (confirm(`Permanently delete ${name}?\n\nThis cannot be undone. Logged hours for this project will remain in All entries but the project itself will be gone.`)) {
      await db.collection('projects').doc(deleteId).delete();
    }
  }
});

makeToggle('archivedToggle', 'archivedBody', 'archivedChevron');

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
// ============================================================
// Generic extra-type cards (ADM, AQ, INT)
// ============================================================
function initExtraTypeCards() {
  $('extraTypesContainer').innerHTML = EXTRA_TYPES.map(({ type, label }) => `
    <div class="card">
      <div class="card-header-row card-toggle" id="toggle-${type}" role="button" tabindex="0" aria-expanded="false">
        <h2>${label} <span class="chevron collapsed" id="chevron-${type}">▾</span></h2>
      </div>
      <div id="body-${type}" class="collapsible-body hidden">
        <form id="form-${type}" class="stacked-form hidden">
          <input type="hidden" id="formId-${type}" />
          <label>Name
            <input type="text" id="formName-${type}" required />
          </label>
          <div class="field-row">
            <label>Code <span class="optional">optional, e.g. AB12</span>
              <input type="text" id="formCode-${type}" maxlength="4" placeholder="AB12" />
            </label>
            <label>Description <span class="optional">optional</span>
              <input type="text" id="formDesc-${type}" />
            </label>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Save ${label}</button>
            <button type="button" class="btn btn-ghost extra-cancel" data-type="${type}">Cancel</button>
          </div>
        </form>
        <div id="access-${type}" class="stacked-form hidden">
          <p class="access-intro">Who can log hours to <strong id="accessName-${type}"></strong>? Leave everyone unchecked to keep it open to your whole team.</p>
          <div id="accessList-${type}" class="checkbox-list"></div>
          <div class="form-actions">
            <button type="button" class="btn btn-primary extra-save-access" data-type="${type}">Save access</button>
            <button type="button" class="btn btn-ghost extra-cancel-access" data-type="${type}">Cancel</button>
          </div>
        </div>
        <div class="card-header-row" style="margin-top:4px">
          <span></span>
          <button type="button" class="btn btn-primary" id="newBtn-${type}">+ New ${label}</button>
        </div>
        <div class="table-wrap">
          <table class="ledger-table" id="table-${type}">
            <thead><tr><th>No.</th><th>Name</th><th>Status</th><th>Visible to</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  `).join('');

  EXTRA_TYPES.forEach(({ type, label }) => {
    // Collapse/expand toggle
    const toggleEl = document.getElementById(`toggle-${type}`);
    const toggleHandler = () => {
      const expanded = toggleEl.getAttribute('aria-expanded') === 'true';
      toggleEl.setAttribute('aria-expanded', String(!expanded));
      document.getElementById(`body-${type}`).classList.toggle('hidden', expanded);
      document.getElementById(`chevron-${type}`).classList.toggle('collapsed', expanded);
    };
    toggleEl.addEventListener('click', toggleHandler);
    toggleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHandler(); } });

    // New button
    document.getElementById(`newBtn-${type}`).addEventListener('click', () => {
      // Auto-expand if collapsed
      const btn = document.getElementById(`toggle-${type}`);
      btn.setAttribute('aria-expanded', 'true');
      document.getElementById(`body-${type}`).classList.remove('hidden');
      document.getElementById(`chevron-${type}`).classList.remove('collapsed');
      currentExtraEdit = { type, id: null };
      document.getElementById(`formId-${type}`).value = '';
      document.getElementById(`formName-${type}`).value = '';
      document.getElementById(`formCode-${type}`).value = '';
      document.getElementById(`formDesc-${type}`).value = '';
      document.getElementById(`access-${type}`).classList.add('hidden');
      document.getElementById(`form-${type}`).classList.remove('hidden');
      document.getElementById(`formName-${type}`).focus();
    });

    document.getElementById(`form-${type}`).addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById(`formName-${type}`).value.trim();
      const code = document.getElementById(`formCode-${type}`).value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const description = document.getElementById(`formDesc-${type}`).value.trim();
      if (!name) return;
      document.getElementById(`formCode-${type}`).value = code;

      if (currentExtraEdit.id) {
        await db.collection('projects').doc(currentExtraEdit.id).update({ name, code, description });
      } else {
        await db.collection('projects').add({
          name, code, description, type, active: true, assignedUserIds: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: currentUser.uid
        });
      }
      document.getElementById(`form-${type}`).classList.add('hidden');
      showStamp('Saved');
    });

    document.getElementById(`table-${type}`).addEventListener('click', async (e) => {
      const editId = e.target.dataset.extraEdit;
      const toggleId = e.target.dataset.extraToggle;
      const accessId = e.target.dataset.extraAccess;

      if (editId) {
        const p = extraCache[type].find(x => x.id === editId);
        currentExtraEdit = { type, id: editId };
        document.getElementById(`formId-${type}`).value = editId;
        document.getElementById(`formName-${type}`).value = p.name;
        document.getElementById(`formCode-${type}`).value = p.code || '';
        document.getElementById(`formDesc-${type}`).value = p.description || '';
        document.getElementById(`access-${type}`).classList.add('hidden');
        document.getElementById(`form-${type}`).classList.remove('hidden');
      }
      if (toggleId) {
        const p = extraCache[type].find(x => x.id === toggleId);
        await db.collection('projects').doc(toggleId).update({ active: p.active === false ? true : false });
      }
      if (accessId) {
        const p = extraCache[type].find(x => x.id === accessId);
        currentExtraAccess = { type, id: accessId };
        document.getElementById(`accessName-${type}`).textContent = p.name;
        const assigned = new Set(p.assignedUserIds || []);
        document.getElementById(`accessList-${type}`).innerHTML = allUsersCache.length
          ? allUsersCache.map(u => `
              <label class="checkbox-row">
                <input type="checkbox" value="${u.uid}" ${assigned.has(u.uid) ? 'checked' : ''} />
                ${escapeHtml(u.name)}
              </label>`).join('')
          : `<p class="empty-state">No one has signed up yet.</p>`;
        document.getElementById(`form-${type}`).classList.add('hidden');
        document.getElementById(`access-${type}`).classList.remove('hidden');
      }
    });
  });

  // Shared delegated handlers for cancel / save-access buttons
  $('extraTypesContainer').addEventListener('click', async (e) => {
    const type = e.target.dataset.type;
    if (!type) return;
    if (e.target.classList.contains('extra-cancel')) {
      document.getElementById(`form-${type}`).classList.add('hidden');
    }
    if (e.target.classList.contains('extra-cancel-access')) {
      document.getElementById(`access-${type}`).classList.add('hidden');
    }
    if (e.target.classList.contains('extra-save-access')) {
      const checked = [...document.getElementById(`accessList-${type}`).querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
      await db.collection('projects').doc(currentExtraAccess.id).update({ assignedUserIds: checked });
      document.getElementById(`access-${type}`).classList.add('hidden');
      showStamp('Saved');
    }
  });
}

function renderExtraTable(type) {
  const tbody = document.getElementById(`table-${type}`);
  if (!tbody) return; // cards not yet initialised
  const tbodyEl = tbody.querySelector('tbody');
  const items = extraCache[type];
  const label = EXTRA_TYPES.find(t => t.type === type).label;
  if (!items.length) {
    tbodyEl.innerHTML = `<tr><td colspan="5" class="empty-state">No ${label} items yet.</td></tr>`;
    return;
  }
  tbodyEl.innerHTML = items.map(p => {
    const n = (p.assignedUserIds || []).length;
    return `
    <tr>
      <td class="num-col">${p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : ''}</td>
      <td>${escapeHtml(p.name)}</td>
      <td><span class="stamp-badge ${p.active === false ? 'stamp-badge-off' : ''}">${p.active === false ? 'Archived' : 'Active'}</span></td>
      <td>${n === 0 ? 'Everyone' : `${n} ${n === 1 ? 'person' : 'people'}`}</td>
      <td class="row-actions">
        <button class="link-btn" data-extra-edit="${p.id}">Edit</button>
        <button class="link-btn" data-extra-access="${p.id}">Access</button>
        <button class="link-btn" data-extra-toggle="${p.id}">${p.active === false ? 'Unarchive' : 'Archive'}</button>
      </td>
    </tr>`;
  }).join('');
}

// ============================================================
// User: weekly hours grid
// ============================================================
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

$('weekPrevBtn').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderWeekGrid(); });
$('weekNextBtn').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderWeekGrid(); });
$('weekTodayBtn').addEventListener('click', () => { weekStart = getMonday(new Date()); renderWeekGrid(); });

$('weekGridTable').addEventListener('click', (e) => {
  const th = e.target.closest('[data-user-sort]');
  if (!th) return;
  const key = th.dataset.userSort;
  if (userSortKey === key) {
    userSortDir = userSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    userSortKey = key;
    userSortDir = 'asc';
  }
  renderWeekGrid();
});

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

  $('hoursHeading').textContent = `Hours week ${isoWeekNumber(weekStart)} · ${weekStart.getFullYear()}`;
  $('weekLabel').textContent = weekRangeLabel(weekStart);

  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dateStrs = weekDates.map(toISODate);

  const sortArrow = (key) => userSortKey === key ? (userSortDir === 'asc' ? ' ▲' : ' ▼') : '';
  $('weekGridHeadRow').innerHTML =
    `<th class="sortable-th${userSortKey==='code'?' sort-active':''}" data-user-sort="code">No.${sortArrow('code')}</th>` +
    `<th class="sortable-th${userSortKey==='name'?' sort-active':''}" data-user-sort="name">Project${sortArrow('name')}</th>` +
    weekDates.map((d, i) => `<th class="num ${i >= 5 ? 'weekend' : ''}">${DAY_NAMES[i]}<span class="day-date">${d.getDate()}/${d.getMonth() + 1}</span></th>`).join('') +
    '<th class="num">Total week</th>' +
    '<th class="num">Total</th>';

  const sortItems = (items) => [...items].sort((a, b) => {
    const va = (a[userSortKey] || '').toLowerCase();
    const vb = (b[userSortKey] || '').toLowerCase();
    const cmp = va.localeCompare(vb);
    return userSortDir === 'asc' ? cmp : -cmp;
  });

  const visibleProjects = sortItems(projectsCache.filter(p => p.active !== false && isProjectVisibleToCurrentUser(p)));
  const visibleExtras = EXTRA_TYPES.map(({ type, label }) => ({
    label,
    items: sortItems((extraCache[type] || []).filter(p => p.active !== false && isProjectVisibleToCurrentUser(p)))
  }));
  const hasItems = visibleProjects.length > 0 || visibleExtras.some(g => g.items.length > 0);
  $('noProjectsState').classList.toggle('hidden', hasItems);
  $('weekGridTable').classList.toggle('hidden', !hasItems);

  const entryFor = (projectId, date) => userEntriesCache.find(en => en.projectId === projectId && en.date === date);
  const allHoursForProject = (projectId) => userEntriesCache.filter(en => en.projectId === projectId).reduce((s, en) => s + en.hours, 0);
  const colspan = 11; // No. + Project + 7 days + Total week + Total

  const renderSection = (items, label) => {
    if (!items.length) return '';
    const header = `<tr class="grid-section-header"><td colspan="${colspan}">${label}</td></tr>`;
    const rows = items.map(p => {
      let rowTotal = 0;
      const cells = dateStrs.map((ds, i) => {
        const en = entryFor(p.id, ds);
        const hours = en ? en.hours : 0;
        rowTotal += hours;
        return `<td class="${i >= 5 ? 'weekend' : ''}"><input type="number" min="0" step="0.25" inputmode="decimal"
          data-project="${p.id}" data-date="${ds}" value="${en ? en.hours : ''}" /></td>`;
      }).join('');
      const overallTotal = allHoursForProject(p.id);
      return `<tr>
        <td class="num-col">${p.code ? `<span class="proj-code">${escapeHtml(p.code)}</span>` : ''}</td>
        <td>${escapeHtml(p.name)}</td>
        ${cells}
        <td class="num row-total">${trimZeros(rowTotal)}</td>
        <td class="num row-total">${trimZeros(overallTotal)}</td>
      </tr>`;
    }).join('');
    return header + rows;
  };

  $('weekGridBody').innerHTML =
    renderSection(visibleProjects, 'Projects') +
    visibleExtras.map(g => renderSection(g.items, g.label)).join('');

  const allVisible = [...visibleProjects, ...visibleExtras.flatMap(g => g.items)];
  const dayTotals = dateStrs.map(ds =>
    allVisible.reduce((sum, p) => {
      const en = entryFor(p.id, ds);
      return sum + (en ? en.hours : 0);
    }, 0)
  );
  const grandTotalWeek = dayTotals.reduce((s, n) => s + n, 0);
  const grandTotalAll = allVisible.reduce((sum, p) => sum + allHoursForProject(p.id), 0);
  $('weekGridFoot').innerHTML = `<tr class="totals-row"><td colspan="2">Total</td>` +
    dayTotals.map((t, i) => `<td class="num right-num ${i >= 5 ? 'weekend' : ''}">${trimZeros(t)}</td>`).join('') +
    `<td class="num right-num">${trimZeros(grandTotalWeek)}</td>` +
    `<td class="num right-num">${trimZeros(grandTotalAll)}</td></tr>`;
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
  const project = projectsCache.find(p => p.id === projectId) ||
    EXTRA_TYPES.flatMap(({ type }) => extraCache[type]).find(p => p.id === projectId);
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
  return (n.toFixed(2).replace(/\.?0+$/, '') || '0').replace('.', ',');
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
    renderWeekOverview();
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

function makeToggle(toggleId, bodyId, chevronId) {
  const el = $(toggleId);
  if (!el) return;
  const handler = () => {
    const expanded = el.getAttribute('aria-expanded') === 'true';
    el.setAttribute('aria-expanded', String(!expanded));
    $(bodyId).classList.toggle('hidden', expanded);
    $(chevronId).classList.toggle('collapsed', expanded);
  };
  el.addEventListener('click', handler);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
  });
}

makeToggle('allEntriesToggle', 'allEntriesBody', 'allEntriesChevron');
makeToggle('weekOverviewToggle', 'weekOverviewBody', 'weekOverviewChevron');
makeToggle('projectTotalsToggle', 'projectTotalsBody', 'projectTotalsChevron');
makeToggle('ratesToggle', 'ratesBody', 'ratesChevron');
makeToggle('archivedUsersToggle', 'archivedUsersBody', 'archivedUsersChevron');

$('ratesTable').addEventListener('click', async (e) => {
  const archiveUid = e.target.dataset.archiveUser;
  const deleteUid = e.target.dataset.deleteUserActive;
  if (!archiveUid && !deleteUid) return;

  const uid = archiveUid || deleteUid;
  const u = allUsersCache.find(x => x.uid === uid);
  const name = u ? u.name : 'this user';

  if (archiveUid) {
    if (!confirm(`Archive ${name}?\n\nThey will no longer appear in the app, but their logged hours are kept. You can unarchive them later.`)) return;
    try {
      await db.collection('users').doc(uid).update({ active: false });
    } catch (err) {
      alert(
        `Couldn't archive ${name}.\n\n` +
        (err.code === 'permission-denied'
          ? 'Firestore rules need updating — repaste firestore.rules into Firebase Console → Databases & Storage → Firestore → Rules → Publish, then try again.'
          : err.message)
      );
    }
  }

  if (deleteUid) {
    if (!confirm(`Permanently delete ${name} from Firestore?\n\nThis removes them from all lists. Their logged hours remain in All entries.\n\nTo fully remove their login, also delete them from Firebase Console → Security → Authentication.`)) return;
    try {
      await db.collection('users').doc(uid).delete();
    } catch (err) {
      alert(
        `Couldn't delete ${name}.\n\n` +
        (err.code === 'permission-denied'
          ? 'Firestore rules need updating — repaste firestore.rules into Firebase Console → Databases & Storage → Firestore → Rules → Publish, then try again.'
          : err.message)
      );
    }
  }
});

$('archivedUsersTable').addEventListener('click', async (e) => {
  const unarchiveUid = e.target.dataset.unarchiveUser;
  const deleteUid = e.target.dataset.deleteUser;

  if (unarchiveUid) {
    await db.collection('users').doc(unarchiveUid).update({ active: true });
  }
  if (deleteUid) {
    const u = archivedUsersCache.find(x => x.uid === deleteUid);
    const name = u ? `"${u.name}"` : 'this user';
    if (confirm(`Permanently delete ${name} from Firestore?\n\nThis removes them from all lists in Hour Power. Their logged hours remain in All entries.\n\nTo fully remove their login, also delete them from Firebase Console → Security → Authentication.`)) {
      await db.collection('users').doc(deleteUid).delete();
    }
  }
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
      <td class="row-actions"><button class="link-btn" data-edit-entry="${en.id}">Edit</button></td>
    </tr>
  `;
  }).join('');

  const total = filteredRows.reduce((s, en) => s + en.hours, 0);
  $('allEntriesTotal').textContent = trimZeros(total);
}

// ============================================================
// Editor: inline entry editing
// ============================================================
function populateEditProjectSelect(currentProjectId) {
  const sel = $('editEntryProject');
  sel.innerHTML = '';
  const addGroup = (label, items) => {
    if (!items.length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    items.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = projectLabelText(p);
      if (p.id === currentProjectId) opt.selected = true;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  };
  EXTRA_TYPES.forEach(({ type, label }) => addGroup(label, extraCache[type] || []));
  addGroup('Projects', projectsCache);
}

function openEntryEditPanel(entryId) {
  const en = allEntriesCache.find(e => e.id === entryId);
  if (!en) return;
  $('editEntryId').value = en.id;
  $('editEntryPerson').textContent = en.userName;
  $('editEntryDate').value = en.date;
  $('editEntryHours').value = en.hours;
  $('editEntryNote').value = en.note || '';
  populateEditProjectSelect(en.projectId);
  $('entryEditPanel').classList.remove('hidden');
  $('editEntryDate').focus();
  $('entryEditPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEntryEditPanel() {
  $('entryEditPanel').classList.add('hidden');
  $('editEntryId').value = '';
}

$('allEntriesTable').addEventListener('click', (e) => {
  const id = e.target.dataset.editEntry;
  if (id) openEntryEditPanel(id);
});

$('cancelEntryEditBtn').addEventListener('click', closeEntryEditPanel);
$('cancelEntryEditBtn2').addEventListener('click', closeEntryEditPanel);

$('entryEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('editEntryId').value;
  const projectId = $('editEntryProject').value;
  const project = projectById(projectId) ||
    EXTRA_TYPES.flatMap(({ type }) => extraCache[type]).find(p => p.id === projectId);
  const date = $('editEntryDate').value;
  const hours = parseFloat($('editEntryHours').value);
  const note = $('editEntryNote').value.trim();
  if (!id || !projectId || !date || isNaN(hours) || hours < 0) return;

  if (hours === 0) {
    if (confirm('Setting hours to 0 will delete this entry. Continue?')) {
      await db.collection('entries').doc(id).delete();
      closeEntryEditPanel();
      showStamp('Deleted');
    }
    return;
  }

  await db.collection('entries').doc(id).update({
    projectId,
    projectName: project ? project.name : '',
    date,
    hours,
    note
  });
  closeEntryEditPanel();
  showStamp('Updated');
});

// ============================================================
// PDF export — formal report with logo, header, table, totals
// ============================================================
async function loadLogoBase64() {
  try {
    const res = await fetch('logo.png');
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

$('exportPdfBtn').addEventListener('click', async () => {
  if (!filteredRows.length) { alert('No entries to export — adjust your filters first.'); return; }

  const btn = $('exportPdfBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();   // 297mm
    const H = doc.internal.pageSize.getHeight();  // 210mm
    const M = 14;  // margin
    const INK  = [28, 42, 46];
    const WHITE = [255, 255, 255];
    const TEAL  = [47, 93, 90];
    const SOFT  = [220, 230, 224];
    const ALT   = [242, 245, 240];

    // ---- Header bar ----
    const HEADER_H = 24;
    doc.setFillColor(...INK);
    doc.rect(0, 0, W, HEADER_H, 'F');

    // Logo
    const logoData = await loadLogoBase64();
    if (logoData) {
      doc.addImage(logoData, 'PNG', M, 3, 18, 18);
    }

    // Title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...WHITE);
    doc.text('Hour Power — Time Registration Report', M + (logoData ? 22 : 0), 12);

    // Sub-line: Urban Power Architecture + Urbanism
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(180, 200, 196);
    doc.text('Urban Power Architecture + Urbanism', M + (logoData ? 22 : 0), 19);

    // Generated date (top right)
    doc.setTextColor(...WHITE);
    doc.setFontSize(7.5);
    doc.text(`Generated: ${new Date().toLocaleDateString('da-DK')}`, W - M, 12, { align: 'right' });

    // ---- Subtitle: active filters ----
    const filters = [];
    const fpVal = $('filterProject').value;
    if (fpVal) {
      const fp = projectById(fpVal) ||
        EXTRA_TYPES.flatMap(({ type }) => extraCache[type]).find(p => p.id === fpVal);
      if (fp) filters.push(`Project: ${projectLabelText(fp)}`);
    }
    const fuVal = $('filterUser').value;
    if (fuVal) {
      const fu = allUsersCache.find(u => u.uid === fuVal);
      if (fu) filters.push(`Person: ${fu.name}`);
    }
    if ($('filterFrom').value) filters.push(`From: ${formatDate($('filterFrom').value)}`);
    if ($('filterTo').value) filters.push(`To: ${formatDate($('filterTo').value)}`);

    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.text(
      filters.length ? filters.join('  ·  ') : 'All entries — no filters applied',
      M, HEADER_H + 8
    );

    // ---- Table ----
    const totalHours = trimZeros(filteredRows.reduce((s, en) => s + en.hours, 0));

    doc.autoTable({
      startY: HEADER_H + 13,
      margin: { left: M, right: M },
      head: [['Date', 'Person', 'Project', 'Client', 'Hours', 'Note']],
      body: filteredRows.map(en => {
        const p = projectById(en.projectId) ||
          EXTRA_TYPES.flatMap(({ type }) => extraCache[type]).find(x => x.id === en.projectId);
        const label = (p && p.code ? `${p.code}  ` : '') + en.projectName;
        return [
          formatDate(en.date),
          en.userName,
          label,
          p ? (p.client || '') : '',
          trimZeros(en.hours),
          en.note || ''
        ];
      }),
      foot: [['', '', '', 'Total', totalHours, '']],
      headStyles: {
        fillColor: INK, textColor: WHITE,
        fontSize: 7.5, fontStyle: 'bold', cellPadding: 3
      },
      footStyles: {
        fillColor: SOFT, textColor: INK,
        fontSize: 7.5, fontStyle: 'bold', cellPadding: 3
      },
      bodyStyles: { fontSize: 7.5, textColor: INK, cellPadding: 2.5 },
      alternateRowStyles: { fillColor: ALT },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 36 },
        2: { cellWidth: 60 },
        3: { cellWidth: 36 },
        4: { cellWidth: 16, halign: 'right', font: 'courier' },
        5: { cellWidth: 'auto' }
      },
      didDrawPage: ({ pageNumber }) => {
        const total = doc.internal.getNumberOfPages();
        doc.setFontSize(6.5);
        doc.setTextColor(160, 160, 160);
        doc.setFont('helvetica', 'normal');
        doc.text('Urban Power Architecture + Urbanism', M, H - 5);
        doc.text(`Page ${pageNumber} of ${total}`, W - M, H - 5, { align: 'right' });
      }
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    doc.save(`hourpower-report-${dateStr}.pdf`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PDF';
  }
});

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
