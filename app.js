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
let userAbsencesCache = [];
let allAbsencesCache = [];
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
let editingProjectUsers = [];
let projectSortKey = 'code';
let projectSortDir = 'desc';
let collapsedParents = new Set();
let userExpandedParents = new Set(); // empty = all parents collapsed by default in user grid

function getParentIds() {
  return new Set(projectsCache.filter(p => p.parentId).map(p => p.parentId).filter(Boolean));
}
function computeParentFees(parentId) {
  const children = projectsCache.filter(p => p.parentId === parentId && p.active !== false);
  return {
    expectedFee: children.reduce((s, c) => s + (c.expectedFee || 0), 0),
    subadvisors:  children.reduce((s, c) => s + (c.subadvisors  || 0), 0)
  };
}
let weekStart = getMonday(new Date());
let editorWeekStart = getMonday(new Date());
let vacCalendarDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let userSortKey = 'code';
let userSortDir = 'desc';

// Generic extra-type system (ADM, AQ, INT — all stored in the projects collection with a type field)
const EXTRA_TYPES = [
  { type: 'adm', label: 'ADM' },
  { type: 'aq',  label: 'AQ'  },
  { type: 'int', label: 'INT' }
];

const ABSENCE_TYPES = [
  { value: '',                  label: '—'                     },
  { value: 'ferielov_half',     label: '½ dag ferielov'        },
  { value: 'ferielov_full',     label: '1 dag ferielov'        },
  { value: 'feriefridag_half',  label: '½ dag feriefridag'     },
  { value: 'feriefridag_full',  label: '1 dag feriefridag'     },
  { value: 'sick',              label: 'Sygedag'               }
];

// Project category colour palettes — each prefix within a category
// gets its own colour; archived > 1 year releases the slot.
const PROJECT_PALETTES = {
  architecture:  ['#B71C1C','#C0392B','#D84315','#BF360C','#6D4C41','#880E4F','#AD1457','#8B0000','#A52714','#7B241C'],
  publicspace:   ['#1B5E20','#2E7D32','#00695C','#004D40','#145A32','#0B5345','#0D6B3C','#117864','#1D6A39','#196F3D'],
  urbanplanning: ['#0D47A1','#1565C0','#01579B','#0277BD','#283593','#1A237E','#303F9F','#0A3D62','#1B4F72','#154360'],
  other:         ['#546E7A','#455A64','#37474F','#607D8B','#78909C','#616161','#757575','#424242','#263238','#90A4AE']
};
const PROJECT_CATEGORY_LABELS = {
  architecture:  'Architecture',
  publicspace:   'Public Space',
  urbanplanning: 'Urban Planning',
  other:         'Other'
};

function getProjectBadgeColor(project) {
  if (!project.code) return null;
  // Children inherit their parent's colour
  if (project.parentId) {
    const parent = projectsCache.find(p => p.id === project.parentId);
    if (parent) return getProjectBadgeColor(parent);
  }
  const cat = project.category || 'other';
  const palette = PROJECT_PALETTES[cat] || PROJECT_PALETTES.other;
  const prefix = project.code.slice(0, 4);
  const oneYearAgoStr = toISODate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

  // Collect all projects in this category that are active OR archived < 1 year
  const relevant = projectsCache.filter(p =>
    (p.category || 'other') === cat &&
    (p.active !== false || (p.archivedAt && p.archivedAt >= oneYearAgoStr))
  );

  // Unique first-4-char prefixes in sorted order → stable color assignment
  const prefixes = [...new Set(
    relevant.map(p => (p.code || '').slice(0, 4)).filter(Boolean)
  )].sort();

  const idx = prefixes.indexOf(prefix);
  return idx >= 0 ? palette[idx % palette.length] : palette[0];
}
const RATE_SCHEDULES = {
  rate: {
    key: 'rateSchedule',
    fields: [
      { field: 'salesRate', label: 'Sales', defaultVal: 0 },
      { field: 'costRate',  label: 'Cost',  defaultVal: 0 }
    ],
    unit: 'DKK/h'
  },
  vac: {
    key: 'vacSchedule',
    fields: [
      { field: 'vacationRate',      label: 'Ferielov',   defaultVal: 2.08 },
      { field: 'feriefridageRate',  label: 'Feriefridag', defaultVal: 0.5  }
    ],
    unit: 'd/mo'
  }
};

// Find the schedule entry applicable on a given date
function findApplicableEntry(schedule, dateStr) {
  if (!schedule || !schedule.length) return null;
  let applicable = null;
  for (const e of schedule) {
    if (e.from <= dateStr && (!applicable || e.from > applicable.from)) applicable = e;
  }
  return applicable;
}

function resolveRateFromSchedule(schedule, dateStr, fallback) {
  const e = findApplicableEntry(schedule, dateStr);
  return e != null ? e.value : fallback;
}

// Find the applicable value from a dated schedule for a given date
function resolveRateFromSchedule(schedule, dateStr, fallback) {
  if (!schedule || !schedule.length) return fallback;
  let applicable = null;
  for (const entry of schedule) {
    if (entry.from <= dateStr && (!applicable || entry.from > applicable.from)) {
      applicable = entry;
    }
  }
  return applicable != null ? applicable.value : fallback;
}
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

// Returns { rate, ytd, total } in vacation days.
// rate  = monthly accrual for the current month's schedule
// ytd   = earned Jan 1 – end of last completed month (this calendar year)
// total = earned since schedule started – end of last completed month
function calcVacation(workWeekSchedule, referenceDate, vacSchedule, rateField, defaultRate) {
  if (!workWeekSchedule || !workWeekSchedule.length) return { rate: 0, ytd: 0, total: 0 };
  const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const scheduleStart = workWeekSchedule.reduce((min, s) => s.from < min ? s.from : min, workWeekSchedule[0].from);
  const ref = referenceDate || new Date();
  const lastMonthEnd = new Date(ref.getFullYear(), ref.getMonth(), 0);
  const yearStart    = new Date(ref.getFullYear(), 0, 1);
  const weeklyHrs = (entry) => {
    if (!entry) return 0;
    const fromDays = KEYS.reduce((s, k) => s + (entry[k] || 0), 0);
    return fromDays > 0 ? fromDays : (entry.hours || 0);
  };
  const resolveVacRate = (mStr) => {
    // New combined vacSchedule format
    if (Array.isArray(vacSchedule)) {
      const e = findApplicableEntry(vacSchedule, mStr);
      if (e) return e[rateField] ?? defaultRate;
    }
    return defaultRate;
  };
  const monthlyRate = (mStr) => {
    let applicable = null;
    for (const e of workWeekSchedule) {
      if (e.from <= mStr && (!applicable || e.from > applicable.from)) applicable = e;
    }
    return applicable ? (weeklyHrs(applicable) / 37) * resolveVacRate(mStr) : 0;
  };
  let total = 0, ytd = 0;
  const schedStartDate = new Date(scheduleStart + 'T00:00:00');
  let m = new Date(scheduleStart.slice(0, 7) + '-01T00:00:00');
  while (m <= lastMonthEnd) {
    const mStr = toISODate(m);
    const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const isFirstMonth = schedStartDate.getFullYear() === m.getFullYear() &&
                         schedStartDate.getMonth()    === m.getMonth();
    let proportion = 1;
    if (isFirstMonth) {
      const startDay = schedStartDate.getDate();
      proportion = startDay === 1 ? 1 : (daysInMonth - startDay) / daysInMonth;
    }
    const refStr = isFirstMonth ? scheduleStart : mStr;
    const rate = monthlyRate(refStr) * proportion;
    total += rate;
    if (m >= yearStart) ytd += rate;
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  const currentMonthStr = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}-01`;
  const rate = monthlyRate(currentMonthStr);
  return { rate, ytd, total };
}
// Weekends always return 0. Returns null if the date is before the schedule starts.
function getFlexHours(dateStr, schedule) {
  if (!schedule || !schedule.length) return null;
  const scheduleStart = schedule.reduce((min, s) => s.from < min ? s.from : min, schedule[0].from);
  if (dateStr < scheduleStart) return null;
  const dow = new Date(dateStr + 'T00:00:00').getDay(); // 0=Sun 6=Sat
  let applicable = null;
  for (const entry of schedule) {
    if (entry.from <= dateStr && (!applicable || entry.from > applicable.from)) {
      applicable = entry;
    }
  }
  if (!applicable) return 0;
  // New format: individual day hours
  const KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayKey = KEYS[dow];
  if (applicable[dayKey] !== undefined) return applicable[dayKey] || 0;
  // Legacy format: hours/week divided evenly Mon–Fri
  if (dow === 0 || dow === 6) return 0;
  return applicable.hours ? applicable.hours / 5 : 0;
}

// Returns the cumulative flex balance from the schedule start up to and including targetDateStr.
// Positive = banked overtime, negative = owed hours.
function computeBalance(targetDateStr, schedule, entriesCache) {
  if (!schedule || !schedule.length) return null;
  const scheduleStart = schedule.reduce((min, s) => s.from < min ? s.from : min, schedule[0].from);
  if (targetDateStr < scheduleStart) return null;
  const hoursByDate = {};
  entriesCache.forEach(en => {
    if (en.date >= scheduleStart && en.date <= targetDateStr) {
      hoursByDate[en.date] = (hoursByDate[en.date] || 0) + en.hours;
    }
  });
  let balance = 0;
  const cursor = new Date(scheduleStart + 'T00:00:00');
  const end    = new Date(targetDateStr  + 'T00:00:00');
  while (cursor <= end) {
    const ds = toISODate(cursor);
    const flex = getFlexHours(ds, schedule) || 0;
    balance += (hoursByDate[ds] || 0) - flex;
    cursor.setDate(cursor.getDate() + 1);
  }
  return balance;
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
    // Always role: user on self-signup — editors are defined by EDITOR_EMAILS in config.js
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

  // Role is determined by email — this overrides anything stored in Firestore,
  // which self-corrects any accidentally promoted accounts.
  const correctRole = EDITOR_EMAILS.map(e => e.toLowerCase()).includes(user.email.toLowerCase())
    ? 'editor' : 'user';
  if (data.role !== correctRole) {
    await db.collection('users').doc(user.uid).update({ role: correctRole });
  }

  currentUser = {
    uid: user.uid,
    name: data.name,
    email: data.email,
    role: correctRole,
    employeeType: data.employeeType || '',
    workWeekSchedule: data.workWeekSchedule || [],
    vacationRate: data.vacationRate != null ? data.vacationRate : 2.08,
    feriefridageRate: data.feriefridageRate != null ? data.feriefridageRate : 0.5
  };

  $('authScreen').classList.add('hidden');
  $('verifyScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('whoami').textContent = `${currentUser.name}${currentUser.role === 'editor' ? ' · editor' : ''}`;

  $('userView').classList.toggle('hidden', currentUser.role !== 'user');
  $('editorView').classList.toggle('hidden', currentUser.role !== 'editor');

  listenProjects();
  if (currentUser.role === 'user') {
    listenUserEntries();
    listenUserRates();
    if (currentUser.employeeType === '2') listenUserAbsences();
  } else {
    initExtraTypeCards();
    listenAllEntriesForEditor();
    listenAllUsers();
    listenRates();
    listenAllAbsences();
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

function projectCodeBadgeHtml(p) {
  if (!p.code) return '';
  const color = (p.type || 'project') === 'project' ? getProjectBadgeColor(p) : null;
  const style = color ? ` style="background:${color};color:#fff"` : '';
  return `<span class="proj-code"${style}>${escapeHtml(p.code)}</span>`;
}

function projectLabelHtml(p) {
  return projectCodeBadgeHtml(p) + escapeHtml(p.name);
}

function projectLabelText(p) {
  return (p.code ? `${p.code} — ` : '') + p.name;
}

function listenAllUsers() {
  allUsersUnsub = db.collection('users').orderBy('name').onSnapshot((snap) => {
    const all = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => u.uid !== currentUser.uid); // exclude only the currently logged-in admin
    allUsersCache = all.filter(u => u.active !== false);
    archivedUsersCache = all.filter(u => u.active === false);
    renderProjectsTable();
    EXTRA_TYPES.forEach(({ type }) => renderExtraTable(type));
    renderRatesTable();
    renderArchivedUsersTable();
    renderWeekOverview();
    renderVacationCalendar();
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

function listenUserRates() {
  db.collection('rates').doc(currentUser.uid).onSnapshot(snap => {
    currentUser.ratesData = snap.exists ? snap.data() : {};
    renderWeekGrid();
  });
}

function listenUserAbsences() {
  db.collection('absences').where('userId', '==', currentUser.uid).onSnapshot(snap => {
    userAbsencesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderWeekGrid();
  });
}

function listenAllAbsences() {
  db.collection('absences').onSnapshot(snap => {
    allAbsencesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderVacationCalendar();
  });
}

// ============================================================
// Editor: vacation calendar
// ============================================================
const VAC_CAL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

$('vacCalPrevBtn').addEventListener('click', (e) => { e.stopPropagation(); vacCalendarDate = new Date(vacCalendarDate.getFullYear(), vacCalendarDate.getMonth() - 1, 1); renderVacationCalendar(); });
$('vacCalNextBtn').addEventListener('click', (e) => { e.stopPropagation(); vacCalendarDate = new Date(vacCalendarDate.getFullYear(), vacCalendarDate.getMonth() + 1, 1); renderVacationCalendar(); });
$('vacCalTodayBtn').addEventListener('click', (e) => { e.stopPropagation(); vacCalendarDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderVacationCalendar(); });

makeToggle('vacationToggle', 'vacationBody', 'vacationChevron');
// Re-render calendar whenever the card is expanded
$('vacationToggle').addEventListener('click', () => {
  if ($('vacationToggle').getAttribute('aria-expanded') === 'true') renderVacationCalendar();
});

function renderVacationCalendar() {
  const label = $('vacCalLabel');
  if (label) label.textContent = vacCalendarDate.toLocaleString('en', { month: 'long', year: 'numeric' });
  const container = $('vacationCalendar');
  if (!container) return;

  const year  = vacCalendarDate.getFullYear();
  const month = vacCalendarDate.getMonth();
  const today = toISODate(new Date());

  const DAY_LETTERS = ['S','M','T','W','T','F','S']; // Sun=0 … Sat=6

  // Build 2 full months of days starting from the 1st of the chosen month
  const totalDays = new Date(year, month + 1, 0).getDate()
                  + new Date(year, month + 2, 0).getDate();

  // Build day metadata
  const days = Array.from({ length: totalDays }, (_, i) => {
    const d   = new Date(year, month, i + 1);
    const ds  = toISODate(d);
    const dow = d.getDay();
    const isNewMonth = d.getDate() === 1 && i > 0;
    return {
      num: d.getDate(), ds, dow, isWE: dow === 0 || dow === 6,
      isToday: ds === today, letter: DAY_LETTERS[dow],
      weekNum: isoWeekNumber(d),
      isNewMonth, monthLabel: isNewMonth ? d.toLocaleString('en', { month: 'long', year: 'numeric' }) : null
    };
  });

  // Group days by ISO week for the header
  const weekGroups = [];
  days.forEach(d => {
    const last = weekGroups[weekGroups.length - 1];
    if (!last || last.week !== d.weekNum) weekGroups.push({ week: d.weekNum, count: 1 });
    else last.count++;
  });

  // Group days by month for the top header row
  const monthGroups = [];
  days.forEach(d => {
    const dd = new Date(d.ds);
    const key = `${dd.getFullYear()}-${dd.getMonth()}`;
    const last = monthGroups[monthGroups.length - 1];
    if (!last || last.key !== key) {
      monthGroups.push({ key, label: dd.toLocaleString('en', { month: 'long', year: 'numeric' }), count: 1 });
    } else last.count++;
  });

  // Absence lookup: { uid: { date: type } }
  const absByUser = {};
  allAbsencesCache.forEach(a => {
    if (!absByUser[a.userId]) absByUser[a.userId] = {};
    absByUser[a.userId][a.date] = a.type;
  });

  const TYPE_STYLE = {
    ferielov_full:     { label: 'F',   bg: '#2E86C1', color: '#fff' },
    ferielov_half:     { label: '½F',  bg: '#85C1E9', color: '#1A5276' },
    feriefridag_full:  { label: 'FF',  bg: '#27AE60', color: '#fff' },
    feriefridag_half:  { label: '½FF', bg: '#82E0AA', color: '#1D6A39' },
    sick:              { label: 'S',   bg: '#E74C3C', color: '#fff' }
  };

  const employees = allUsersCache.filter(u => u.active !== false);
  if (!employees.length) {
    container.innerHTML = `<p class="empty-state">No active employees.</p>`;
    return;
  }

  const monthHeaderRow = `<tr>
    <th class="vac-name-col"></th>
    ${monthGroups.map(m => `<th colspan="${m.count}" class="vac-month-header">${m.label.toUpperCase()}</th>`).join('')}
  </tr>`;

  const weekHeaderRow = `<tr>
    <th class="vac-name-col"></th>
    ${weekGroups.map(w => `<th colspan="${w.count}" class="vac-week-num">W${w.week}</th>`).join('')}
  </tr>`;

  const dayHeaderRow = `<tr>
    <th class="vac-name-col vac-name"></th>
    ${days.map(d => `<th class="vac-col-day${d.isWE ? ' vac-we' : ''}${d.isToday ? ' vac-today-col' : ''}${d.isNewMonth ? ' vac-new-month' : ''}">
      <div class="vac-day-num">${d.num}</div>
    </th>`).join('')}
  </tr>`;

  const bodyRows = employees.map(u => {
    const userAbs = absByUser[u.uid] || {};
    const cells = days.map(d => {
      const type = userAbs[d.ds];
      const s    = type ? TYPE_STYLE[type] : null;
      const bg   = d.isWE ? 'var(--line-soft)' : d.isToday ? 'var(--accent-soft)' : '';
      const style = s
        ? `background:${s.bg};color:${s.color}`
        : bg ? `background:${bg}` : '';
      const title = type ? (ABSENCE_TYPES.find(x => x.value === type)?.label || type) : '';
      return `<td class="vac-cell${d.isNewMonth ? ' vac-new-month' : ''}" style="${style}" title="${title}">${s ? s.label : ''}</td>`;
    }).join('');
    return `<tr><th class="vac-name">${escapeHtml(u.name)}</th>${cells}</tr>`;
  }).join('');

  container.innerHTML = `
    <div class="vac-scroll">
      <table class="vac-grid">
        <thead>${monthHeaderRow}${weekHeaderRow}${dayHeaderRow}</thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
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

const EMPLOYEE_TYPES = [
  { value: '',  label: '— Select type —' },
  { value: '1', label: '1 Partner' },
  { value: '2', label: '2 Permanent position' },
  { value: '3', label: '3 Freelance position' },
  { value: '4', label: '4 Intern position' }
];

function renderCombinedRateLines(uid, schedKey) {
  const rs = RATE_SCHEDULES[schedKey === 'rateSchedule' ? 'rate' : 'vac'];
  const schedule = (ratesCache[uid] || {})[schedKey] || [];
  if (!schedule.length) return `<p class="work-week-empty">No entries yet — click + Add.</p>`;
  return schedule.map((s, i) => {
    const fieldInputs = rs.fields.map(f => `
      <label class="ww-day-label">${f.label}
        <input type="number" min="0" step="${rs.unit === 'd/mo' ? '0.01' : '1'}" class="rate-input rate-combo-val"
          data-uid="${uid}" data-key="${schedKey}" data-field="${f.field}" data-idx="${i}"
          value="${s[f.field] ?? f.defaultVal}" />
      </label>`).join('');
    return `
      <div class="work-week-line rate-combo-line">
        <input type="date" class="ww-date rate-combo-date" data-uid="${uid}" data-key="${schedKey}" data-idx="${i}" value="${s.from || ''}" />
        ${fieldInputs}
        <span class="ww-unit">${rs.unit}</span>
        <button type="button" class="link-btn link-danger rate-combo-remove" data-uid="${uid}" data-key="${schedKey}" data-idx="${i}">×</button>
      </div>`;
  }).join('');
}

async function saveCombinedRateSchedule(uid, schedKey) {
  const rs = RATE_SCHEDULES[schedKey === 'rateSchedule' ? 'rate' : 'vac'];
  const container = document.getElementById(`rslines-${uid}-${schedKey}`);
  if (!container) return;
  const schedule = ((ratesCache[uid] || {})[schedKey] || []).map((s, i) => {
    const fromEl = container.querySelector(`.rate-combo-date[data-idx="${i}"]`);
    const entry = { from: fromEl ? fromEl.value : s.from };
    rs.fields.forEach(f => {
      const el = container.querySelector(`.rate-combo-val[data-field="${f.field}"][data-idx="${i}"]`);
      entry[f.field] = el && el.value !== '' ? parseFloat(el.value) : f.defaultVal;
    });
    return entry;
  }).filter(e => e.from).sort((a, b) => a.from.localeCompare(b.from));
  await db.collection('rates').doc(uid).set({ [schedKey]: schedule }, { merge: true });
  if (!ratesCache[uid]) ratesCache[uid] = {};
  ratesCache[uid][schedKey] = schedule;
  showStamp('Saved');
}

function renderRatesTable() {
  const tbody = $('ratesTable').querySelector('tbody');
  if (!allUsersCache.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No active employees yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = allUsersCache.map(u => {
    const isPermanent = u.employeeType === '2';

    const makeSection = (schedKey, title, addLabel) => `
      <div class="user-rate-section">
        <div class="work-week-header">
          <span class="work-week-label">${title}</span>
          <button type="button" class="btn btn-ghost btn-sm rate-combo-add" data-uid="${u.uid}" data-key="${schedKey}">+ ${addLabel}</button>
        </div>
        <div class="work-week-lines" id="rslines-${u.uid}-${schedKey}">
          ${renderCombinedRateLines(u.uid, schedKey)}
        </div>
      </div>`;

    const workWeekSection = isPermanent ? `
      <div class="user-rate-section">
        <div class="work-week-header">
          <span class="work-week-label">Working week schedule</span>
          <button type="button" class="btn btn-ghost btn-sm add-work-week" data-uid="${u.uid}">+ Add</button>
        </div>
        <div class="work-week-lines" id="wwlines-${u.uid}">
          ${renderWorkWeekLines(u.uid, u.workWeekSchedule || [])}
        </div>
      </div>` : '';

    const vacSection = isPermanent
      ? makeSection('vacSchedule', 'Vac. rate (ferielov) & Vac. day off rate (feriefridag)', 'Add')
      : '';

    return `
    <tr>
      <td><input type="text" class="rate-name-input" data-uid="${u.uid}" data-field="name" value="${escapeHtml(u.name)}" /></td>
      <td>
        <select class="rate-type-select" data-uid="${u.uid}">
          ${EMPLOYEE_TYPES.map(t => `<option value="${t.value}"${u.employeeType === t.value ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
        </select>
      </td>
      <td class="row-actions"><button class="link-btn" data-archive-user="${u.uid}">Archive</button></td>
    </tr>
    <tr class="work-week-row">
      <td colspan="3">
        <div class="work-week-section">
          ${makeSection('rateSchedule', 'Sales & Cost rate', 'Add')}
          ${workWeekSection}
          ${vacSection}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderWorkWeekLines(uid, schedule) {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  if (!schedule.length) {
    return `<p class="work-week-empty">No schedule yet — click + Add to set a working week.</p>`;
  }
  return schedule.map((s, i) => {
    const total = KEYS.reduce((sum, k) => sum + (parseFloat(s[k]) || 0), 0);
    const dayInputs = KEYS.map((k, di) => `
      <label class="ww-day-label">${DAYS[di]}
        <input type="number" min="0" max="24" step="0.5" class="ww-day rate-input"
          data-uid="${uid}" data-idx="${i}" data-day="${k}"
          value="${s[k] != null ? s[k] : ''}" placeholder="0" />
      </label>`).join('');
    return `
      <div class="work-week-line">
        <div class="ww-row-top">
          <input type="date" class="ww-date" data-uid="${uid}" data-idx="${i}" value="${s.from || ''}" />
          <span class="ww-total-label">= <strong class="ww-total" id="wwtotal-${uid}-${i}">${trimZeros(total)}</strong> hrs/week</span>
          <button type="button" class="link-btn link-danger ww-remove" data-uid="${uid}" data-idx="${i}">×</button>
        </div>
        <div class="ww-days-row">${dayInputs}</div>
      </div>`;
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

async function saveWorkWeekSchedule(uid) {
  const u = allUsersCache.find(x => x.uid === uid);
  if (!u) return;
  const lines = document.getElementById(`wwlines-${uid}`);
  if (!lines) return;
  const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const schedule = (u.workWeekSchedule || []).map((s, i) => {
    const dateEl = lines.querySelector(`.ww-date[data-idx="${i}"]`);
    const entry = { from: dateEl ? dateEl.value : s.from };
    KEYS.forEach(k => {
      const el = lines.querySelector(`.ww-day[data-idx="${i}"][data-day="${k}"]`);
      entry[k] = el && el.value !== '' ? parseFloat(el.value) : (s[k] || 0);
    });
    // Update the live total label
    const total = KEYS.reduce((sum, k) => sum + (entry[k] || 0), 0);
    const totalEl = document.getElementById(`wwtotal-${uid}-${i}`);
    if (totalEl) totalEl.textContent = trimZeros(total);
    return entry;
  }).filter(s => s.from);
  schedule.sort((a, b) => a.from.localeCompare(b.from));
  await db.collection('users').doc(uid).update({ workWeekSchedule: schedule });
  u.workWeekSchedule = schedule;
  // Also update currentUser if this is the logged-in user (editor editing themselves)
  if (currentUser && currentUser.uid === uid) currentUser.workWeekSchedule = schedule;
  showStamp('Saved');
}

$('ratesTable').addEventListener('click', async (e) => {
  // + Add combined rate schedule row
  if (e.target.classList.contains('rate-combo-add')) {
    const uid = e.target.dataset.uid;
    const key = e.target.dataset.key;
    const rs = RATE_SCHEDULES[key === 'rateSchedule' ? 'rate' : 'vac'];
    if (!ratesCache[uid]) ratesCache[uid] = {};
    const entry = { from: '' };
    rs.fields.forEach(f => { entry[f.field] = f.defaultVal; });
    (ratesCache[uid][key] = ratesCache[uid][key] || []).push(entry);
    const container = document.getElementById(`rslines-${uid}-${key}`);
    if (container) container.innerHTML = renderCombinedRateLines(uid, key);
    return;
  }
  // × Remove combined rate schedule row
  if (e.target.classList.contains('rate-combo-remove')) {
    const uid = e.target.dataset.uid;
    const key = e.target.dataset.key;
    const idx = parseInt(e.target.dataset.idx);
    const entry = (ratesCache[uid]?.[key] || [])[idx];
    const fromLabel = entry?.from ? ` starting ${formatDate(entry.from)}` : '';
    const label = key === 'rateSchedule' ? 'Sales & Cost rate' : 'Vac. rate';
    if (!confirm(`Delete the ${label} entry${fromLabel}?\n\nThis cannot be undone.`)) return;
    if (ratesCache[uid]) ratesCache[uid][key] = (ratesCache[uid][key] || []).filter((_, i) => i !== idx);
    await db.collection('rates').doc(uid).set({ [key]: ratesCache[uid][key] }, { merge: true });
    const container = document.getElementById(`rslines-${uid}-${key}`);
    if (container) container.innerHTML = renderCombinedRateLines(uid, key);
    showStamp('Saved');
    return;
  }
  // + Add working week row
  if (e.target.classList.contains('add-work-week')) {
    const uid = e.target.dataset.uid;
    const u = allUsersCache.find(x => x.uid === uid);
    if (!u) return;
    u.workWeekSchedule = [...(u.workWeekSchedule || []), { from: '', mon: 7.4, tue: 7.4, wed: 7.4, thu: 7.4, fri: 7.4, sat: 0, sun: 0 }];
    const lines = document.getElementById(`wwlines-${uid}`);
    if (lines) lines.innerHTML = renderWorkWeekLines(uid, u.workWeekSchedule);
    return;
  }
  // × Remove working week row
  if (e.target.classList.contains('ww-remove')) {
    const uid = e.target.dataset.uid;
    const idx = parseInt(e.target.dataset.idx);
    const u = allUsersCache.find(x => x.uid === uid);
    if (!u) return;
    const entry = (u.workWeekSchedule || [])[idx];
    const fromLabel = entry?.from ? ` starting ${formatDate(entry.from)}` : '';
    if (!confirm(`Delete the working week schedule${fromLabel}?\n\nThis cannot be undone.`)) return;
    u.workWeekSchedule = (u.workWeekSchedule || []).filter((_, i) => i !== idx);
    await db.collection('users').doc(uid).update({ workWeekSchedule: u.workWeekSchedule });
    const lines = document.getElementById(`wwlines-${uid}`);
    if (lines) lines.innerHTML = renderWorkWeekLines(uid, u.workWeekSchedule);
    showStamp('Saved');
  }
  // Archive employee
  if (e.target.dataset.archiveUser) {
    const uid = e.target.dataset.archiveUser;
    const u = allUsersCache.find(x => x.uid === uid);
    const name = u ? u.name : 'this employee';
    if (!confirm(`Archive ${name}?\n\nThey will no longer appear in the app, but their logged hours are kept. You can unarchive them later.`)) return;
    try {
      await db.collection('users').doc(uid).update({ active: false });
    } catch (err) {
      alert(`Couldn't archive ${name}.\n\n` + (err.code === 'permission-denied'
        ? 'Firestore rules need updating.'
        : err.message));
    }
  }
});

$('ratesTable').addEventListener('change', async (e) => {
  // Rate schedule date or value changed
  if (e.target.classList.contains('rate-combo-date') || e.target.classList.contains('rate-combo-val')) {
    await saveCombinedRateSchedule(e.target.dataset.uid, e.target.dataset.key);
    return;
  }
  // Employee type dropdown
  if (e.target.matches('select[data-uid]')) {
    const uid = e.target.dataset.uid;
    const employeeType = e.target.value;
    try {
      await db.collection('users').doc(uid).update({ employeeType });
      const u = allUsersCache.find(x => x.uid === uid);
      if (u) u.employeeType = employeeType;
      renderRatesTable();
      showStamp('Saved');
    } catch (err) { alert('Could not save employee type: ' + err.message); }
    return;
  }
  // Working week date or day hours changed
  if (e.target.classList.contains('ww-date') || e.target.classList.contains('ww-day')) {
    await saveWorkWeekSchedule(e.target.dataset.uid);
    return;
  }
});

$('ratesTable').addEventListener('blur', async (e) => {
  if (!e.target.matches('input[data-field="name"]')) return;
  const uid = e.target.dataset.uid;
  const name = e.target.value.trim();
  if (!name) { e.target.value = allUsersCache.find(u => u.uid === uid)?.name || ''; return; }
  try {
    await db.collection('users').doc(uid).update({ name });
    const u = allUsersCache.find(x => x.uid === uid);
    if (u) u.name = name;
    showStamp('Saved');
  } catch (err) { alert('Could not save name: ' + err.message); }
}, true);

function formatDkk(n) {
  return n.toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' kr.';
}

function resolveProjectRate(project, dateStr, uid) {
  const r = ratesCache[uid] || {};
  const rateEntry = findApplicableEntry(r.rateSchedule || [], dateStr);
  const standardSales = rateEntry?.salesRate ??
    resolveRateFromSchedule(r.salesRateSchedule, dateStr, r.salesRate || 0);
  const standardCost  = rateEntry?.costRate  ??
    resolveRateFromSchedule(r.costRateSchedule,  dateStr, r.costRate  || 0);

  // Check for project-specific rate lines; for children also check parent's lines
  const checkProject = (proj) => {
    const rateData = proj && proj.rateLines;
    if (!rateData) return null;
    const lines = Array.isArray(rateData) ? rateData : (rateData[uid] || []);
    let applicable = null;
    for (const line of lines) {
      if (line.usedFrom <= dateStr && (!applicable || line.usedFrom > applicable.usedFrom)) applicable = line;
    }
    return applicable;
  };

  let applicable = checkProject(project);
  if (!applicable && project?.parentId) {
    const parent = projectsCache.find(p => p.id === project.parentId);
    applicable = checkProject(parent);
  }

  const salesRate = (applicable && applicable.salesRate != null) ? applicable.salesRate : standardSales;
  const costRate  = (applicable && applicable.costRate  != null) ? applicable.costRate  : standardCost;
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
  const isParent = project && getParentIds().has(project.id);

  // For parent projects, aggregate entries from all child projects
  const relevantIds = isParent
    ? projectsCache.filter(p => p.parentId === projectId).map(p => p.id)
    : [projectId];

  const byUser = {};
  allEntriesCache.filter(en => relevantIds.includes(en.projectId)).forEach(en => {
    if (!byUser[en.userId]) byUser[en.userId] = { userName: en.userName, hours: 0, cost: 0, sales: 0 };
    const entryProject = projectById(en.projectId);
    const { salesRate, costRate } = resolveProjectRate(entryProject, en.date, en.userId);
    byUser[en.userId].hours += en.hours;
    byUser[en.userId].cost  += en.hours * costRate;
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

  // Project-level fee summary — use children's sum if this is a parent container
  const _fees = (project && getParentIds().has(project.id))
    ? computeParentFees(project.id)
    : project;
  const expectedFee = (_fees && _fees.expectedFee) || 0;
  const subadvisors  = (_fees && _fees.subadvisors)  || 0;
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
  // Sort projects by code descending (highest first) for the dropdowns
  const sortedProjects = [...projectsCache].sort((a, b) => {
    const codeA = a.code || '';
    const codeB = b.code || '';
    if (codeA && codeB) return codeB.localeCompare(codeA);
    if (codeA) return -1;
    if (codeB) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const projectOptions = (items) => items.map(p =>
    `<option value="${p.id}">${escapeHtml(projectLabelText(p))}</option>`).join('');

  // All entries filter — Projects first, then ADM/AQ/INT
  const filterSel = $('filterProject');
  const filterCurrent = filterSel.value;
  filterSel.innerHTML = '<option value="">All items</option>';
  if (sortedProjects.length) {
    filterSel.innerHTML += `<optgroup label="Projects">${projectOptions(sortedProjects)}</optgroup>`;
  }
  EXTRA_TYPES.forEach(({ type, label }) => {
    if (extraCache[type].length) {
      filterSel.innerHTML += `<optgroup label="${label}">${projectOptions(extraCache[type])}</optgroup>`;
    }
  });
  filterSel.value = filterCurrent;

  // Project totals — Projects only, sorted descending
  const totalsSel = $('totalsProjectSelect');
  const totalsCurrent = totalsSel.value;
  totalsSel.innerHTML = '<option value="">Choose a project…</option>' + projectOptions(sortedProjects);
  totalsSel.value = totalsCurrent;
}

function renderProjectsTable() {
  const tbody = $('projectsTable').querySelector('tbody');
  const thead = $('projectsTable').querySelector('thead tr');

  const cols = [
    { key: 'code',     label: 'No.'        },
    { key: 'name',     label: 'Project'    },
    { key: 'client',   label: 'Client'     },
    { key: 'category', label: 'Category'   },
    { key: 'visible',  label: 'Visible to' }
  ];
  thead.innerHTML = '<th class="toggle-col"></th>' + cols.map(({ key, label }) => {
    const isActive = projectSortKey === key;
    const arrow = isActive ? (projectSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable-th${isActive ? ' sort-active' : ''}" data-sort-key="${key}">${label}${arrow}</th>`;
  }).join('') + '<th></th>';

  const active = projectsCache.filter(p => p.active !== false);
  const parentIds = getParentIds();

  // Populate parent dropdown (only standalone + current parents, not children)
  const parentSel = $('projectParent');
  const curParentVal = parentSel.value;
  parentSel.innerHTML = '<option value="">— Standalone —</option>' +
    active
      .filter(p => !p.parentId) // can't make a child a parent
      .filter(p => p.id !== editingProjectId) // can't be own parent
      .sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name))
      .map(p => `<option value="${p.id}">${projectLabelText(p)}</option>`)
      .join('');
  parentSel.value = curParentVal;

  const statusSelect = (p) => `
    <select class="proj-status-select" data-status-project="${p.id}">
      <option value="active"${(!p.status || p.status === 'active') ? ' selected' : ''}>Active</option>
      <option value="paused"${p.status === 'paused' ? ' selected' : ''}>Paused</option>
    </select>`;

  if (!active.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No projects yet — create the first one above.</td></tr>`;
    renderArchivedProjectsTable();
    return;
  }

  // Sort active projects
  active.sort((a, b) => {
    let cmp;
    if (projectSortKey === 'visible') {
      cmp = (a.assignedUserIds || []).length - (b.assignedUserIds || []).length;
    } else {
      cmp = (a[projectSortKey] || '').toLowerCase().localeCompare((b[projectSortKey] || '').toLowerCase());
    }
    return projectSortDir === 'asc' ? cmp : -cmp;
  });

  // Build grouped rows: parents with children, then standalones
  const childrenByParent = {};
  active.forEach(p => {
    if (p.parentId) {
      if (!childrenByParent[p.parentId]) childrenByParent[p.parentId] = [];
      childrenByParent[p.parentId].push(p);
    }
  });

  const rows = [];
  const rendered = new Set();

  active.forEach(p => {
    if (rendered.has(p.id) || p.parentId) return; // skip children here
    rendered.add(p.id);

    if (parentIds.has(p.id)) {
      // Parent row
      const fees = computeParentFees(p.id);
      const collapsed = collapsedParents.has(p.id);
      const children = (childrenByParent[p.id] || []).sort((a, b) =>
        (a.code || a.name).localeCompare(b.code || b.name));
      const n = (p.assignedUserIds || []).length;
      rows.push(`
      <tr class="project-parent-row${p.status === 'paused' ? ' proj-paused' : ''}">
        <td class="toggle-col"><span class="parent-toggle link-btn" data-toggle-parent="${p.id}">${collapsed ? '▶' : '▼'}</span></td>
        <td class="num-col">${projectCodeBadgeHtml(p)}</td>
        <td><strong>${escapeHtml(p.name)}</strong> <span class="optional">(${children.length} sub-project${children.length !== 1 ? 's' : ''})</span></td>
        <td>${escapeHtml(p.client || '')}</td>
        <td>${escapeHtml(PROJECT_CATEGORY_LABELS[p.category] || '—')}</td>
        <td>${n === 0 ? 'Everyone' : `${n} ${n === 1 ? 'person' : 'people'}`}</td>
        <td class="row-actions">${statusSelect(p)}
          <button class="link-btn" data-edit-project="${p.id}">Edit</button>
          <button class="link-btn" data-access-project="${p.id}">Access</button>
          <button class="link-btn" data-toggle-project="${p.id}">Archive</button>
        </td>
      </tr>`);

      if (!collapsed) {
        children.forEach(c => {
          rendered.add(c.id);
          const cn = (c.assignedUserIds || []).length;
          rows.push(`
          <tr class="project-child-row${c.status === 'paused' ? ' proj-paused' : ''}">
            <td class="toggle-col"></td>
            <td class="num-col">${projectCodeBadgeHtml(c)}</td>
            <td>${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.client || p.client || '')}</td>
            <td>${escapeHtml(PROJECT_CATEGORY_LABELS[c.category || p.category] || '—')}</td>
            <td>${cn === 0 ? 'Everyone' : `${cn} ${cn === 1 ? 'person' : 'people'}`}</td>
            <td class="row-actions">${statusSelect(c)}
              <button class="link-btn" data-edit-project="${c.id}">Edit</button>
              <button class="link-btn" data-access-project="${c.id}">Access</button>
              <button class="link-btn" data-toggle-project="${c.id}">Archive</button>
            </td>
          </tr>`);
        });
      }
    } else {
      // Standalone row
      const n = (p.assignedUserIds || []).length;
      rows.push(`
      <tr class="${p.status === 'paused' ? 'proj-paused' : ''}">
        <td class="toggle-col"></td>
        <td class="num-col">${projectCodeBadgeHtml(p)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.client || '')}</td>
        <td>${escapeHtml(PROJECT_CATEGORY_LABELS[p.category] || '—')}</td>
        <td>${n === 0 ? 'Everyone' : `${n} ${n === 1 ? 'person' : 'people'}`}</td>
        <td class="row-actions">${statusSelect(p)}
          <button class="link-btn" data-edit-project="${p.id}">Edit</button>
          <button class="link-btn" data-access-project="${p.id}">Access</button>
          <button class="link-btn" data-toggle-project="${p.id}">Archive</button>
        </td>
      </tr>`);
    }
  });

  tbody.innerHTML = rows.join('');
  renderArchivedProjectsTable();
}

function renderArchivedProjectsTable() {
  const archived = projectsCache.filter(p => p.active === false);
  const tbody = $('archivedTable').querySelector('tbody');
  $('archivedEmpty').classList.toggle('hidden', archived.length > 0);
  $('archivedTable').classList.toggle('hidden', archived.length === 0);
  tbody.innerHTML = archived.map(p => `
    <tr>
      <td class="num-col">${projectCodeBadgeHtml(p)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client || '')}</td>
      <td class="row-actions">
        <button class="link-btn" data-unarchive-project="${p.id}">Unarchive</button>
        <button class="link-btn link-danger" data-delete-project="${p.id}">Delete</button>
      </td>
    </tr>`).join('');
}

// Auto-fill category and client from parent when a parent is selected
$('projectParent').addEventListener('change', () => {
  const parentId = $('projectParent').value;
  const parent = parentId ? projectsCache.find(p => p.id === parentId) : null;
  if (parent) {
    $('projectCategory').value = parent.category || '';
    $('projectClient').value = parent.client || '';
    $('projectCategory').disabled = true;
    $('projectClient').disabled = true;
  } else {
    $('projectCategory').disabled = false;
    $('projectClient').disabled = false;
  }
  updateFeeRowVisibility();
});

function updateFeeRowVisibility() {
  const pid = editingProjectId;
  const isParent = pid && getParentIds().has(pid);
  $('projectFeeRow').classList.toggle('hidden', isParent);
  $('projectFeeNote').classList.toggle('hidden', !isParent);
}

$('newProjectBtn').addEventListener('click', () => {
  editingProjectId = null;
  $('projectId').value = '';
  $('projectName').value = '';
  $('projectParent').value = '';
  $('projectCode').value = '';
  $('projectCategory').value = '';
  $('projectCategory').disabled = false;
  $('projectClient').value = '';
  $('projectClient').disabled = false;
  $('projectDesc').value = '';
  $('projectExpectedFee').value = '';
  $('projectSubadvisors').value = '';
  $('projectFeeRow').classList.remove('hidden');
  $('projectFeeNote').classList.add('hidden');
  buildRateLinesSections(null);
  $('accessPanel').classList.add('hidden');
  $('projectForm').classList.remove('hidden');
  $('projectName').focus();
});

const RATE_ROW_COUNT = 5;

function buildRateLinesSections(project) {
  // Determine which users to show rate rows for
  const assignedIds = project ? (project.assignedUserIds || []) : [];
  editingProjectUsers = assignedIds.length > 0
    ? allUsersCache.filter(u => assignedIds.includes(u.uid))
    : [...allUsersCache];

  const rateData = (project && project.rateLines && !Array.isArray(project.rateLines))
    ? project.rateLines : {};

  const container = document.getElementById('rateLinesSections');
  if (!editingProjectUsers.length) {
    container.innerHTML = `<p class="empty-state" style="margin:8px 0">No employees assigned yet — set access first, then add per-employee rates.</p>`;
    return;
  }

  container.innerHTML = editingProjectUsers.map((u, ui) => {
    const userLines = (rateData[u.uid] || []).slice(0, RATE_ROW_COUNT);
    const rows = Array.from({ length: RATE_ROW_COUNT }, (_, ri) => {
      const line = userLines[ri] || {};
      return `<tr>
        <td><input type="date" id="rd_${ui}_${ri}" value="${line.usedFrom || ''}" /></td>
        <td class="num"><input type="number" min="0" step="1" class="rate-input" id="rs_${ui}_${ri}" value="${line.salesRate != null ? line.salesRate : ''}" /></td>
        <td class="num"><input type="number" min="0" step="1" class="rate-input" id="rc_${ui}_${ri}" value="${line.costRate != null ? line.costRate : ''}" /></td>
      </tr>`;
    }).join('');
    return `
      <div class="user-rate-section">
        <p class="user-rate-name">${escapeHtml(u.name)}</p>
        <div class="table-wrap">
          <table class="ledger-table rate-lines-table">
            <thead><tr><th>Used from</th><th class="num">Sales rate (DKK/h)</th><th class="num">Cost rate (DKK/h)</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

function readPerUserRateLines() {
  const result = {};
  editingProjectUsers.forEach((u, ui) => {
    const lines = [];
    for (let ri = 0; ri < RATE_ROW_COUNT; ri++) {
      const dateEl = document.getElementById(`rd_${ui}_${ri}`);
      if (!dateEl) continue;
      const usedFrom = dateEl.value;
      if (!usedFrom) continue;
      const salesRaw = document.getElementById(`rs_${ui}_${ri}`).value.trim();
      const costRaw  = document.getElementById(`rc_${ui}_${ri}`).value.trim();
      const salesRate = (salesRaw !== '' && !isNaN(parseFloat(salesRaw)) && parseFloat(salesRaw) >= 0) ? parseFloat(salesRaw) : null;
      const costRate  = (costRaw  !== '' && !isNaN(parseFloat(costRaw))  && parseFloat(costRaw)  >= 0) ? parseFloat(costRaw)  : null;
      lines.push({ usedFrom, salesRate, costRate });
    }
    lines.sort((a, b) => a.usedFrom.localeCompare(b.usedFrom));
    if (lines.length) result[u.uid] = lines;
  });
  return result;
}

$('cancelProjectBtn').addEventListener('click', () => {
  $('projectForm').classList.add('hidden');
});

$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('projectName').value.trim();
  const code = $('projectCode').value.trim().slice(0, 10);
  const category = $('projectCategory').value;
  const client = $('projectClient').value.trim();
  const description = $('projectDesc').value.trim();
  const parentId = $('projectParent').value || null;
  const isParent = editingProjectId && getParentIds().has(editingProjectId);
  const expectedFee = isParent ? undefined : parseNonNegative($('projectExpectedFee').value);
  const subadvisors  = isParent ? undefined : parseNonNegative($('projectSubadvisors').value);
  const rateLines = readPerUserRateLines();
  if (!name) return;

  // Enforce max 10 children per parent
  if (parentId && !editingProjectId) {
    const existingChildren = projectsCache.filter(p => p.parentId === parentId && p.active !== false);
    if (existingChildren.length >= 10) {
      alert('This parent project already has 10 sub-projects — the maximum. Archive or delete one before adding another.');
      return;
    }
  }

  if (editingProjectId) {
    const updates = { name, code, category, client, description, parentId, rateLines };
    if (!isParent) { updates.expectedFee = expectedFee; updates.subadvisors = subadvisors; }
    await db.collection('projects').doc(editingProjectId).update(updates);
  } else {
    const parent = parentId ? projectsCache.find(p => p.id === parentId) : null;
    const inheritedAccess = (parent && parent.assignedUserIds) ? [...parent.assignedUserIds] : [];
    await db.collection('projects').add({
      name, code, category, client, description, parentId, expectedFee, subadvisors, rateLines,
      active: true, assignedUserIds: inheritedAccess,
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

$('projectsTable').addEventListener('change', async (e) => {
  if (e.target.dataset.statusProject) {
    const id = e.target.dataset.statusProject;
    const status = e.target.value;
    await db.collection('projects').doc(id).update({ status });
    showStamp('Saved');
  }
});

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
  // Collapse/expand parent
  if (e.target.dataset.toggleParent) {
    const pid = e.target.dataset.toggleParent;
    if (collapsedParents.has(pid)) collapsedParents.delete(pid);
    else collapsedParents.add(pid);
    renderProjectsTable();
    return;
  }
  const editId = e.target.dataset.editProject;
  const toggleId = e.target.dataset.toggleProject;
  const accessId = e.target.dataset.accessProject;

  if (editId) {
    const p = projectsCache.find(x => x.id === editId);
    editingProjectId = editId;
    $('projectId').value = editId;
    $('projectName').value = p.name;
    $('projectCode').value = p.code || '';
    $('projectCategory').value = p.category || '';
    $('projectClient').value = p.client || '';
    // Parent setup
    const parentId = p.parentId || '';
    $('projectParent').value = parentId;
    $('projectCategory').disabled = !!parentId;
    $('projectClient').disabled = !!parentId;
    updateFeeRowVisibility();
    $('projectDesc').value = p.description || '';
    $('projectExpectedFee').value = p.expectedFee || '';
    $('projectSubadvisors').value = p.subadvisors || '';
    buildRateLinesSections(p);
    $('accessPanel').classList.add('hidden');
    $('projectForm').classList.remove('hidden');
  }
  if (toggleId) {
    await db.collection('projects').doc(toggleId).update({ active: false, archivedAt: toISODate(new Date()) });
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
      <td class="num-col">${projectCodeBadgeHtml(p)}</td>
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

  // Shared colgroup: same fixed column widths for grid table and flex table
  const colgroup = `
    <col style="width:28px">
    <col style="width:75px">
    <col>
    <col style="width:58px"><col style="width:58px"><col style="width:58px">
    <col style="width:58px"><col style="width:58px"><col style="width:58px"><col style="width:58px">
    <col style="width:78px">
    <col style="width:78px">`;
  $('weekGridCols').innerHTML = colgroup;

  const sortArrow = (key) => userSortKey === key ? (userSortDir === 'asc' ? ' ▲' : ' ▼') : '';
  $('weekGridHeadRow').innerHTML =
    `<th class="toggle-col"></th>` +
    `<th class="sortable-th${userSortKey==='code'?' sort-active':''}" data-user-sort="code">No.${sortArrow('code')}</th>` +
    `<th class="sortable-th${userSortKey==='name'?' sort-active':''}" data-user-sort="name">Project${sortArrow('name')}</th>` +
    weekDates.map((d, i) => `<th class="num ${i >= 5 ? 'weekend' : ''}">${DAY_NAMES[i]}<span class="day-date">${d.getDate()}/${d.getMonth() + 1}</span></th>`).join('') +
    '<th class="num">Total<span class="day-date">week</span></th>' +
    '<th class="num">Total<span class="day-date">YTD</span></th>';

  const sortItems = (items) => [...items].sort((a, b) => {
    const va = (a[userSortKey] || '').toLowerCase();
    const vb = (b[userSortKey] || '').toLowerCase();
    const cmp = va.localeCompare(vb);
    return userSortDir === 'asc' ? cmp : -cmp;
  });

  const parentIds = getParentIds();

  const activeProjects = projectsCache.filter(p =>
    p.active !== false && isProjectVisibleToCurrentUser(p)
  );
  const childrenByParentUser = {};
  activeProjects.filter(p => p.parentId).forEach(p => {
    if (!childrenByParentUser[p.parentId]) childrenByParentUser[p.parentId] = [];
    childrenByParentUser[p.parentId].push(p);
  });
  const topLevelProjects = sortItems(activeProjects.filter(p => !p.parentId));

  const visibleExtras = EXTRA_TYPES.map(({ type, label }) => ({
    label,
    items: sortItems((extraCache[type] || []).filter(p =>
      p.active !== false && isProjectVisibleToCurrentUser(p)
    ))
  }));

  const hasItems = topLevelProjects.length > 0 || visibleExtras.some(g => g.items.length > 0);
  $('noProjectsState').classList.toggle('hidden', hasItems);
  $('weekGridTable').classList.toggle('hidden', !hasItems);

  const entryFor = (projectId, date) => userEntriesCache.find(en => en.projectId === projectId && en.date === date);
  const yearStart  = `${weekStart.getFullYear()}-01-01`;
  const weekEndStr = toISODate(addDays(weekStart, 6));
  const ytdHoursForProject = (projectId) => userEntriesCache
    .filter(en => en.projectId === projectId && en.date >= yearStart && en.date <= weekEndStr)
    .reduce((s, en) => s + en.hours, 0);
  const colspan = 12; // toggle + No. + Project + 7 days + Total week + Total YTD

  const renderInputRow = (p) => {
    const isPaused = p.status === 'paused';
    let rowTotal = 0;
    const cells = dateStrs.map((ds, i) => {
      const en = entryFor(p.id, ds);
      const hours = en ? en.hours : 0;
      rowTotal += hours;
      return `<td class="${i >= 5 ? 'weekend' : ''}"><input type="number" min="0" step="0.25" inputmode="decimal"
        data-project="${p.id}" data-date="${ds}" value="${en ? en.hours : ''}"
        ${isPaused ? 'disabled title="This project is paused"' : ''} /></td>`;
    }).join('');
    return `<tr class="${isPaused ? 'proj-paused' : ''}">
      <td class="toggle-col"></td>
      <td class="num-col">${projectCodeBadgeHtml(p)}</td>
      <td>${escapeHtml(p.name)}${isPaused ? ' <span class="paused-badge">Paused</span>' : ''}</td>
      ${cells}
      <td class="num row-total">${trimZeros(rowTotal)}</td>
      <td class="num row-total">${trimZeros(ytdHoursForProject(p.id))}</td>
    </tr>`;
  };

  const renderProjectsSection = () => {
    if (!topLevelProjects.length) return '';
    let html = `<tr class="grid-section-header"><td colspan="${colspan}">Projects</td></tr>`;
    topLevelProjects.forEach(p => {
      if (parentIds.has(p.id)) {
        const children = (childrenByParentUser[p.id] || [])
          .sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name));
        const isExpanded = userExpandedParents.has(p.id);
        const dayTots = dateStrs.map(ds =>
          children.reduce((s, c) => { const en = entryFor(c.id, ds); return s + (en ? en.hours : 0); }, 0)
        );
        const weekTot = dayTots.reduce((s, n) => s + n, 0);
        const ytdTot  = children.reduce((s, c) => s + ytdHoursForProject(c.id), 0);
        const dayCells = dayTots.map((t, i) =>
          `<td class="${i >= 5 ? 'weekend' : ''}" style="text-align:center;color:var(--ink-soft);font-size:0.82rem">${t > 0 ? trimZeros(t) : ''}</td>`
        ).join('');
        html += `<tr class="grid-parent-row">
          <td class="toggle-col">
            <span class="grid-parent-toggle" data-toggle-user-parent="${p.id}">${isExpanded ? '▼' : '▶'}</span>
          </td>
          <td class="num-col">${projectCodeBadgeHtml(p)}</td>
          <td>${escapeHtml(p.name)} <span class="optional">(${children.length})</span></td>
          ${dayCells}
          <td class="num row-total">${trimZeros(weekTot)}</td>
          <td class="num row-total">${trimZeros(ytdTot)}</td>
        </tr>`;
        if (isExpanded) children.forEach(c => { html += renderInputRow(c); });
      } else {
        html += renderInputRow(p);
      }
    });
    return html;
  };

  const renderSection = (items, label) => {
    if (!items.length) return '';
    const header = `<tr class="grid-section-header"><td colspan="${colspan}">${label}</td></tr>`;
    return header + items.map(renderInputRow).join('');
  };

  $('weekGridBody').innerHTML =
    renderProjectsSection() +
    visibleExtras.map(g => renderSection(g.items, g.label)).join('');

  // Absence dropdown row — permanent employees only
  if (currentUser.employeeType === '2') {
    const absenceCells = dateStrs.map((ds, i) => {
      const a = userAbsencesCache.find(x => x.date === ds);
      const opts = ABSENCE_TYPES.map(t =>
        `<option value="${t.value}"${a && a.type === t.value ? ' selected' : ''}>${t.label}</option>`).join('');
      return `<td class="${i >= 5 ? 'weekend' : ''}">
        <select class="absence-select" data-date="${ds}">${opts}</select>
      </td>`;
    }).join('');
    $('weekGridBody').innerHTML += `
      <tr class="grid-section-header absence-header"><td colspan="${colspan}">Absence</td></tr>
      <tr class="absence-row"><td class="toggle-col"></td><td colspan="2"></td>${absenceCells}<td></td><td></td></tr>`;
  }

  // All loggable rows for footer totals (children always included even when collapsed)
  const allLoggable = [
    ...topLevelProjects.filter(p => !parentIds.has(p.id)),
    ...Object.values(childrenByParentUser).flat(),
    ...visibleExtras.flatMap(g => g.items)
  ];
  const dayTotals = dateStrs.map(ds =>
    allLoggable.reduce((sum, p) => {
      const en = entryFor(p.id, ds);
      return sum + (en ? en.hours : 0);
    }, 0)
  );
  const grandTotalWeek = dayTotals.reduce((s, n) => s + n, 0);
  const grandTotalYTD  = allLoggable.reduce((sum, p) => sum + ytdHoursForProject(p.id), 0);
  $('weekGridFoot').innerHTML = `<tr class="totals-row"><td class="toggle-col"></td><td colspan="2">Total</td>` +
    dayTotals.map((t, i) => `<td class="${i >= 5 ? 'weekend' : ''}"><span class="foot-num">${trimZeros(t)}</span></td>`).join('') +
    `<td><span class="foot-num">${trimZeros(grandTotalWeek)}</span></td>` +
    `<td><span class="foot-num">${trimZeros(grandTotalYTD)}</span></td></tr>`;

  // Show/hide and populate the Flex and Vacation cards
  const isPermanent = currentUser.employeeType === '2';
  $('flexCard').classList.toggle('hidden', !isPermanent);
  $('vacCard').classList.toggle('hidden', !isPermanent);

  if (isPermanent) {
    const schedule = currentUser.workWeekSchedule || [];
    if (schedule.length) {
      const fmt = (v, sign = false) => {
        if (v === null) return '<span class="flex-na">–</span>';
        const s = trimZeros(Math.abs(v));
        if (!sign) return s;
        return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
      };
      const fn = (v, sign = false) => `<span class="foot-num">${fmt(v, sign)}</span>`;

      const prevDayStr = toISODate(addDays(weekStart, -1));
      let balance = computeBalance(prevDayStr, schedule, userEntriesCache) || 0;
      const today = toISODate(new Date());

      const DAY_LABELS = weekDates.map((d, i) => `${DAY_NAMES[i]} ${d.getDate()}/${d.getMonth()+1}`);
      let flexWeekTotal = 0, diffWeekTotal = 0;

      const flexVals = [], diffVals = [], balVals = [];
      for (let i = 0; i < 7; i++) {
        const ds = dateStrs[i];
        const flex = getFlexHours(ds, schedule);
        const diff = flex !== null ? dayTotals[i] - flex : null;
        if (diff !== null) { balance += diff; flexWeekTotal += flex; diffWeekTotal += diff; }
        const isFuture = ds > today;
        flexVals.push(fmt(flex));
        diffVals.push(fmt(diff, true));
        balVals.push(flex !== null && !isFuture ? fmt(balance, true) : '–');
      }

      $('flexTableCols').innerHTML = colgroup;

      const dayHeadCells = weekDates.map((d, i) =>
        `<th class="num${i >= 5 ? ' weekend' : ''}">${DAY_NAMES[i]}<span class="day-date">${d.getDate()}/${d.getMonth()+1}</span></th>`
      ).join('');
      $('flexTableHead').innerHTML =
        `<th class="toggle-col"></th><th></th><th></th>` +
        dayHeadCells +
        `<th class="num">Total<span class="day-date">week</span></th><th></th>`;

      const flexRowData = [
        { label: 'Flex',       vals: flexVals,  total: fn(flexWeekTotal) },
        { label: 'Difference', vals: diffVals,  total: fn(diffWeekTotal, true) },
        { label: 'Balance',    vals: balVals,   total: '' }
      ];
      $('flexTableBody').innerHTML = flexRowData.map(row => `
        <tr>
          <td class="toggle-col"></td><td></td>
          <td class="flex-label">${row.label}</td>
          ${row.vals.map((v, i) => `<td class="num${i >= 5 ? ' weekend' : ''}">${v}</td>`).join('')}
          <td class="num">${row.total}</td>
          <td></td>
        </tr>`).join('');

      // Render Vacation card
      const weekEnd = addDays(weekStart, 6);
      const ratesData = currentUser.ratesData || {};
      const vacSched = ratesData.vacSchedule || [];
      const vac   = calcVacation(schedule, weekEnd, vacSched, 'vacationRate', 2.08);
      const ferie = calcVacation(schedule, weekEnd, vacSched, 'feriefridageRate', 0.5);
      const fmtDays = (d) => `${trimZeros(Math.round(d * 100) / 100)} d`;
      const weekEndStr2 = toISODate(weekEnd);
      const yearStr = `${weekEnd.getFullYear()}-01-01`;
      const flUsedYTD   = userAbsencesCache.filter(a => (a.type==='ferielov_full'||a.type==='ferielov_half')&&a.date>=yearStr&&a.date<=weekEndStr2).reduce((s,a)=>s+(a.type==='ferielov_full'?1:0.5),0);
      const flUsedTotal = userAbsencesCache.filter(a =>  a.type==='ferielov_full'||a.type==='ferielov_half').reduce((s,a)=>s+(a.type==='ferielov_full'?1:0.5),0);
      const fdUsedYTD   = userAbsencesCache.filter(a => (a.type==='feriefridag_full'||a.type==='feriefridag_half')&&a.date>=yearStr&&a.date<=weekEndStr2).reduce((s,a)=>s+(a.type==='feriefridag_full'?1:0.5),0);
      const fdUsedTotal = userAbsencesCache.filter(a =>  a.type==='feriefridag_full'||a.type==='feriefridag_half').reduce((s,a)=>s+(a.type==='feriefridag_full'?1:0.5),0);
      const fmtBal = (e, u) => `${fmtDays(e)} − ${fmtDays(u)} = <strong>${fmtDays(Math.round((e-u)*100)/100)}</strong>`;

      $('vacSummaryTableBody').innerHTML = `
        <tr><td class="flex-label" style="font-weight:700;padding-top:8px">Vac. rate (ferielov)</td><td class="num">${fmtDays(vac.rate)}/mo</td></tr>
        <tr><td class="flex-label">Ferielov YTD</td><td class="num">${fmtBal(vac.ytd, flUsedYTD)}</td></tr>
        <tr><td class="flex-label">Ferielov total</td><td class="num">${fmtBal(vac.total, flUsedTotal)}</td></tr>
        <tr><td class="flex-label" style="font-weight:700;padding-top:12px">Vac. day off rate (feriefridag)</td><td class="num">${fmtDays(ferie.rate)}/mo</td></tr>
        <tr><td class="flex-label">Feriefridag YTD</td><td class="num">${fmtBal(ferie.ytd, fdUsedYTD)}</td></tr>
        <tr><td class="flex-label">Feriefridag total</td><td class="num">${fmtBal(ferie.total, fdUsedTotal)}</td></tr>`;
    }
  }
    dayTotals.map((t, i) => `<td class="${i >= 5 ? 'weekend' : ''}"><span class="foot-num">${trimZeros(t)}</span></td>`).join('') +
    `<td><span class="foot-num">${trimZeros(grandTotalWeek)}</span></td>` +
    `<td><span class="foot-num">${trimZeros(grandTotalYTD)}</span></td></tr>`;

  // Flex / Difference / Balance rows — permanent position employees only
}

$('weekGridBody').addEventListener('click', (e) => {
  const pid = e.target.dataset.toggleUserParent;
  if (pid) {
    if (userExpandedParents.has(pid)) userExpandedParents.delete(pid);
    else userExpandedParents.add(pid);
    renderWeekGrid();
  }
});

$('weekGridBody').addEventListener('change', async (e) => {
  // Absence dropdown
  if (e.target.classList.contains('absence-select')) {
    const date = e.target.dataset.date;
    const type = e.target.value;
    const docId = `${currentUser.uid}_${date}`;
    if (!type) {
      await db.collection('absences').doc(docId).delete().catch(() => {});
    } else {
      await db.collection('absences').doc(docId).set({
        userId: currentUser.uid,
        userName: currentUser.name,
        date,
        type,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    return;
  }

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
makeToggle('rateLineToggle', 'rateLinesSections', 'rateLineChevron');
makeToggle('flexToggle', 'flexBody', 'flexChevron');
makeToggle('vacSummaryToggle', 'vacSummaryBody', 'vacSummaryChevron');
makeToggle('archivedUsersToggle', 'archivedUsersBody', 'archivedUsersChevron');

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
    const codeBadge = p && projectCodeBadgeHtml(p);
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
