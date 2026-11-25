import './style.css';
import { auth, db, firebaseConfigured } from './firebase.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updateProfile
} from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  deleteDoc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from 'firebase/firestore';

const root = document.querySelector('#app');
const normalizeUsername = value => String(value ?? '').trim().toLowerCase();
const validUsername = value => /^[a-z0-9][a-z0-9._-]{2,23}$/.test(value);
// Firebase Email/Password requires an email-shaped identifier. This reserved
// project-local alias is internal only; users enter and see their username.
const authEmailForUsername = username => `${username}@${import.meta.env.VITE_FIREBASE_AUTH_DOMAIN}`;
const fallbackUsername = uid => `student_${String(uid).slice(0, 8).toLowerCase()}`;
const displayFullName = profile => [profile?.fullName, profile?.patronymic].filter(Boolean).join(' ') || profile?.username || 'Пользователь';

const today = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const dateText = value => {
  if (!value) return 'Без срока';
  const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value + (String(value).length === 10 ? 'T12:00:00' : ''));
  return Number.isNaN(date.getTime()) ? 'Без срока' : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};
const mondayOf = value => {
  const d = new Date(value);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const groupCollection = name => collection(db, 'groups', state.group.id, name);
const groupDocument = (name, id) => doc(db, 'groups', state.group.id, name, id);
const makeInviteCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
};

const state = {
  user: null,
  profile: null,
  memberships: [],
  activeMembership: null,
  group: null,
  role: null,
  tab: 'overview',
  tasks: [],
  suggestions: [],
  lessons: [],
  progress: new Map(),
  attendance: [],
  attendanceRecords: [],
  groupMembers: [],
  selectedAttendanceLessonId: null,
  attendanceDate: today(),
  scheduleEditorSlot: null,
  selectedScheduleLessonId: null,
  busy: false,
  authMode: 'login'
};

function notify(message, kind = 'info') {
  const box = document.querySelector('#toast');
  if (!box) return;
  box.textContent = message;
  box.dataset.kind = kind;
  box.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => box.classList.remove('visible'), 3500);
}

function setBusy(flag) {
  state.busy = flag;
  root.querySelectorAll('button, input, select, textarea').forEach(element => {
    element.disabled = flag;
  });
}

function frame(html) {
  root.innerHTML = html + '<div id="toast" role="status" aria-live="polite"></div>';
}

function renderSetup() {
  frame('<main class="setup"><div class="monogram">S</div><p class="eyebrow">НАСТРОЙКА FIREBASE</p><h1>STUDIUM</h1><p class="muted">Подключи Firebase, чтобы запустить учебное пространство.</p><article class="panel"><h2>Добавь параметры Web App</h2><ol><li>Создай отдельный проект в <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">Firebase Console</a>.</li><li>Добавь Web App и скопируй значения Firebase config.</li><li>Включи Authentication → Sign-in method → Email/Password.</li><li>Создай базу Firestore в Production mode.</li><li>Создай локальный файл <code>.env</code> на основе <code>.env.example</code>.</li><li>Опубликуй правила из <code>firestore.rules</code> и индексы из <code>firestore.indexes.json</code>.</li></ol><p class="notice">Firebase Web config и apiKey идентифицируют приложение, но не заменяют защиту данных. Безопасность обеспечивают опубликованные Firestore Security Rules. Не добавляй Admin SDK private key в браузер или GitHub.</p></article></main>');
}

function renderAuth(mode = 'login', message = '') {
  const signup = mode === 'signup';
  state.authMode = mode;
  frame('<main class="auth"><section class="auth-intro"><div class="monogram">S</div><p class="eyebrow">YOUR ACADEMIC SPACE</p><h1>STUDIUM</h1><p>Всё важное для учёбы — в одном пространстве.</p><div class="ornament">— ✦ —</div></section><section class="panel auth-panel"><div class="switch"><button type="button" data-mode="login" class="' + (!signup ? 'active' : '') + '">Войти</button><button type="button" data-mode="signup" class="' + (signup ? 'active' : '') + '">Регистрация</button></div><h2>' + (signup ? 'Создать аккаунт' : 'С возвращением') + '</h2><p class="muted">' + (message ? esc(message) : (signup ? 'Создай аккаунт, чтобы присоединиться к своей группе.' : 'Войди в своё учебное пространство.')) + '</p><form id="auth-form" class="form">' + (signup ? '<label>ФИО<input name="full_name" minlength="2" maxlength="80" autocomplete="name" required placeholder="Жабов Жаб Жабович"></label>' : '') + '<label>Логин<input name="username" type="text" minlength="3" maxlength="24" autocapitalize="none" spellcheck="false" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,23}" required placeholder=""><small class="muted">3–24 символа: латинские буквы, цифры, точка, дефис или подчёркивание.</small></label><label>Пароль<input name="password" type="password" minlength="8" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" required placeholder="Не менее 8 символов"></label><button class="btn primary" type="submit">' + (signup ? 'Создать аккаунт' : 'Войти') + '</button></form><p class="foot muted">STUDIUM · учебное пространство твоей группы</p></section></main>');
}

async function ensureProfile(user) {
  const profileRef = doc(db, 'users', user.uid);
  const snapshot = await getDoc(profileRef);
  if (snapshot.exists()) {
    const profile = snapshot.data();
    const profilePatch = {};
    if (!profile.username) {
      const fromAuth = normalizeUsername((user.email || '').split('@')[0]);
      profile.username = validUsername(fromAuth) ? fromAuth : fallbackUsername(user.uid);
      profilePatch.username = profile.username;
    }
    if (typeof profile.patronymic !== 'string') {
      profile.patronymic = '';
      profilePatch.patronymic = '';
    }
    if (Object.keys(profilePatch).length) {
      profilePatch.updatedAt = serverTimestamp();
      await updateDoc(profileRef, profilePatch);
    }
    state.profile = profile;
    return;
  }
  const fromAuth = normalizeUsername((user.email || '').split('@')[0]);
  const username = validUsername(fromAuth) ? fromAuth : fallbackUsername(user.uid);
  const fullName = user.displayName || username || 'Студент';
  const profile = {
    fullName,
    username,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(profileRef, profile);
  state.profile = { fullName, patronymic: '', username };
}

async function loadMemberships() {
  const membershipsRef = collection(db, 'users', state.user.uid, 'groups');
  const snapshot = await getDocs(membershipsRef);
  state.memberships = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
}

// Recover a missing leader-membership document only for groups owned by this
// authenticated user. Firestore Rules independently verify groups/{id}.createdBy.
async function restoreOwnedLeaderMemberships() {
  for (const membership of state.memberships) {
    if (membership.role !== 'leader') continue;
    const memberRef = doc(db, 'groups', membership.groupId, 'members', state.user.uid);
    const memberSnapshot = await getDoc(memberRef);
    if (memberSnapshot.exists()) continue;

    await setDoc(memberRef, {
      userId: state.user.uid,
      displayName: displayFullName(state.profile),
      role: 'leader',
      joinedAt: serverTimestamp()
    });
  }
}

async function boot(user = auth.currentUser) {
  if (!firebaseConfigured) return renderSetup();
  state.user = user || null;
  if (!state.user) {
    state.profile = null;
    state.group = null;
    state.memberships = [];
    return renderAuth(state.authMode || 'login');
  }

  try {
    await ensureProfile(state.user);
  } catch (error) {
    error.message = 'Не удалось прочитать профиль: ' + error.message;
    throw error;
  }
  try {
    await loadMemberships();
  } catch (error) {
    error.message = 'Не удалось загрузить список групп: ' + error.message;
    throw error;
  }
  try {
    await restoreOwnedLeaderMemberships();
  } catch (error) {
    console.warn('STUDIUM leader membership repair:', error);
    // Continue to the normal workspace path; the read diagnostics below will
    // identify whether the missing membership is actually blocking access.
  }

  if (!state.memberships.length) return renderOnboarding();

  const saved = localStorage.getItem('studium-group');
  const membership = state.memberships.find(item => item.groupId === saved) || state.memberships[0];
  await selectGroup(membership.groupId);
}

function renderOnboarding() {
  frame('<main class="onboard"><header><a class="wordmark" href="#">STUDIUM</a><button class="btn ghost" data-action="logout">Выйти</button></header><section><p class="eyebrow">ДОБРО ПОЖАЛОВАТЬ</p><h1>Твоя учебная<br><em>группа начинается здесь.</em></h1><p class="muted lead">Создай новое пространство или присоединись к группе по коду приглашения.</p><div class="onboard-grid"><form id="create-group" class="panel form"><span class="tile-icon">＋</span><h2>Создать группу</h2><p class="muted">Ты станешь старостой группы.</p><label>Название<input name="name" required minlength="2" maxlength="80" placeholder="Например, ИС-21"></label><button class="btn primary">Создать группу</button></form><form id="join-group" class="panel form"><span class="tile-icon">↗</span><h2>Вступить в группу</h2><p class="muted">Введи код, который отправил староста.</p><label>Код приглашения<input name="code" required maxlength="12" placeholder="A4K8P2QW9T2"></label><button class="btn secondary">Присоединиться</button></form></div></section></main>');
}

async function selectGroup(groupId) {
  const membership = state.memberships.find(item => item.groupId === groupId);
  if (!membership) throw new Error('Группа не найдена в твоём списке.');
  let groupSnapshot;
  try {
    groupSnapshot = await getDoc(doc(db, 'groups', groupId));
  } catch (error) {
    error.message = 'Не удалось открыть группу: ' + error.message;
    throw error;
  }
  if (!groupSnapshot.exists()) throw new Error('Учебная группа не найдена.');
  state.group = { id: groupSnapshot.id, ...groupSnapshot.data() };
  state.activeMembership = membership;
  state.role = membership.role;
  localStorage.setItem('studium-group', groupId);
  await loadWorkspace();
  renderWorkspace();
}

async function loadWorkspace() {
  const gid = state.group.id;
  const tasksRef = collection(db, 'groups', gid, 'tasks');
  const lessonsRef = collection(db, 'groups', gid, 'lessons');
  const suggestionsRef = collection(db, 'groups', gid, 'taskSuggestions');
  const progressRef = collection(db, 'groups', gid, 'taskProgress');
  const attendanceRef = collection(db, 'groups', gid, 'attendanceResponses');

  const taskQuery = query(tasksRef, orderBy('lessonDate', 'asc'));
  const lessonQuery = query(lessonsRef, orderBy('weekday', 'asc'), orderBy('weekNumber', 'asc'), orderBy('startsAt', 'asc'));
  const suggestionQuery = state.role === 'leader'
    ? query(suggestionsRef, where('status', '==', 'pending'), orderBy('createdAt', 'desc'))
    : query(suggestionsRef, where('submittedBy', '==', state.user.uid), orderBy('createdAt', 'desc'));
  const progressQuery = query(progressRef, where('userId', '==', state.user.uid));
  const attendanceConstraints = [where('lessonDate', '==', state.attendanceDate)];
  if (state.role !== 'leader') attendanceConstraints.push(where('userId', '==', state.user.uid));
  const attendanceQuery = query(attendanceRef, ...attendanceConstraints);

  const leaderRosterQuery = state.role === 'leader'
    ? getDocs(collection(db, 'groups', gid, 'members'))
    : Promise.resolve({ docs: [] });
  const officialAttendanceQuery = state.role === 'leader'
    ? getDocs(query(collection(db, 'groups', gid, 'attendanceRecords'), where('lessonDate', '==', state.attendanceDate)))
    : Promise.resolve({ docs: [] });

  const readQuery = async (label, promise) => {
    try {
      return await promise;
    } catch (error) {
      console.error('STUDIUM Firestore query failed:', label, error);
      error.message = label + ': ' + error.message;
      throw error;
    }
  };
  const [tasks, suggestions, lessons, progress, attendance, members, attendanceRecords] = await Promise.all([
    readQuery('Домашние задания', getDocs(taskQuery)),
    readQuery('Предложения ДЗ', getDocs(suggestionQuery)),
    readQuery('Расписание', getDocs(lessonQuery)),
    readQuery('Личный прогресс', getDocs(progressQuery)),
    readQuery('Предварительная посещаемость', getDocs(attendanceQuery)),
    readQuery('Список участников группы', leaderRosterQuery),
    readQuery('Официальная посещаемость', officialAttendanceQuery)
  ]);

  state.tasks = tasks.docs.map(item => ({ id: item.id, ...item.data() }))
    .sort((a,b) => String(a.lessonDate || a.dueDate || '').localeCompare(String(b.lessonDate || b.dueDate || '')));
  state.suggestions = suggestions.docs.map(item => ({ id: item.id, ...item.data() }));
  state.lessons = lessons.docs.map(item => ({ id: item.id, ...item.data() }));
  state.progress = new Map(progress.docs.map(item => [item.data().taskId, item.data().completed === true]));
  state.attendance = attendance.docs.map(item => ({ id: item.id, ...item.data() }));
  state.groupMembers = members.docs.map(item => ({ id: item.id, ...item.data() }));
  state.attendanceRecords = attendanceRecords.docs.map(item => ({ id: item.id, ...item.data() }));
}

function navButton(tab, icon, title) {
  return '<button type="button" class="' + (state.tab === tab ? 'active' : '') + '" data-tab="' + tab + '"><span>' + icon + '</span>' + title + '</button>';
}

function renderWorkspace() {
  const leader = state.role === 'leader';
  const name = displayFullName(state.profile);
  const tabs = [
    navButton('overview', '⌂', 'Обзор'),
    navButton('schedule', '▦', 'Расписание и ДЗ'),
    ...(leader ? [navButton('moderation', '◇', 'Модерация <b>' + state.suggestions.filter(item => item.status === 'pending').length + '</b>')] : []),
    navButton('attendance', '◷', 'Посещаемость'),
    navButton('library', '▤', 'Материалы'),
    navButton('manage', '⚙', 'Группа')
  ].join('');

  frame('<div class="layout"><aside class="sidebar"><a class="wordmark" href="#">STUDIUM</a><div class="group-box"><small>УЧЕБНАЯ ГРУППА</small><strong>' + esc(state.group.name) + '</strong><span class="role">' + (leader ? 'Староста' : 'Студент') + '</span></div><nav>' + tabs + '</nav><div class="side-user"><div class="avatar">' + esc(name.slice(0,1).toUpperCase()) + '</div><div><strong>' + esc(name) + '</strong><small>' + esc(state.profile?.username ? '@' + state.profile.username : '') + '</small></div><button class="btn ghost" data-action="logout">Выйти</button></div></aside><main class="main"><header class="mobile-head"><button class="btn ghost" data-action="menu">☰</button><a class="wordmark" href="#">STUDIUM</a><span class="role">' + (leader ? 'Староста' : 'Студент') + '</span></header><div class="content">' + renderCurrentTab() + '</div></main></div>');
}

function heading(eyebrow, title, subtitle, action = '') {
  return '<div class="heading"><div><p class="eyebrow">' + eyebrow + '</p><h1>' + title + '</h1><p class="muted">' + subtitle + '</p></div>' + action + '</div>';
}

function empty(title, text) {
  return '<div class="empty"><div>✳</div><h3>' + title + '</h3><p>' + text + '</p></div>';
}

function renderCurrentTab() {
  if (state.tab === 'tasks' || state.tab === 'schedule') return renderSchedule();
  if (state.tab === 'moderation' && state.role === 'leader') return renderModeration();
  if (state.tab === 'attendance') return renderAttendance();
  if (state.tab === 'library') return heading('БИБЛИОТЕКА', 'Материалы', 'Методички, ссылки, презентации и лекции.') +
    '<div class="grid-two"><article class="panel"><h2>Материалы группы</h2><p class="muted">Подключение файлов через Firebase Storage — следующий этап.</p></article><article class="panel"><h2>Лекции</h2><p class="muted">Отдельная библиотека лекций будет подключена к Firestore и Storage.</p></article></div>';
  if (state.tab === 'manage') return renderManage();
  return renderOverview();
}

function renderOverview() {
  const pending = state.suggestions.filter(item => item.status === 'pending').length;
  const completed = state.tasks.filter(item => state.progress.get(item.id)).length;
  const nextTask = state.tasks.find(item => item.lessonDate);
  return heading('STUDIUM / ОБЗОР', 'Добро пожаловать', esc(displayFullName(state.profile)), '<button class="btn primary" data-tab="tasks">Открыть задания →</button>') +
    '<div class="stats"><article><small>Заданий в группе</small><strong>' + state.tasks.length + '</strong></article><article><small>Выполнено тобой</small><strong>' + completed + '</strong></article><article><small>Ближайшая пара</small><strong class="date-stat">' + esc(nextTask ? dateText(nextTask.lessonDate) : 'Нет заданий') + '</strong></article><article><small>На модерации</small><strong>' + (state.role === 'leader' ? pending : '—') + '</strong></article></div>' +
    '<section class="section"><div class="section-title"><h2>Ближайшие задания</h2><button class="text-btn" data-tab="tasks">Все задания →</button></div>' + taskCards(state.tasks.slice(0,3)) + '</section>';
}

function taskCards(items) {
  if (!items.length) return empty('Пока нет заданий', 'Добавь задание или предложи его старосте.');
  const weekdayNames = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  return '<div class="task-list">' + items.map(task => {
    const done = state.progress.get(task.id) === true;
    const lesson = state.lessons.find(item => item.id === task.lessonId);
    const weekday = task.weekday || lesson?.weekday;
    const dayLabel = weekdayNames[weekday] || '';
    const dateLabel = task.lessonDate ? dateText(task.lessonDate) : 'Дата пары не указана';
    const timeLabel = task.lessonTime || lesson?.startsAt || '';
    const pairLabel = [dayLabel, dateLabel, timeLabel].filter(Boolean).join(' · ');
    return '<article class="task-card ' + (done ? 'done' : '') + '"><div class="task-copy"><small>' + esc(task.subject || 'Без предмета') + '</small><h3>' + esc(task.title) + '</h3><p>' + esc(task.description || '') + '</p><div class="meta"><span>Пара: ' + esc(pairLabel || dateLabel) + '</span></div></div><label class="check"><input type="checkbox" data-progress="' + esc(task.id) + '" ' + (done ? 'checked' : '') + '> Выполнено</label></article>';
  }).join('') + '</div>';
}

function taskForm(lesson) {
  if (!lesson) return '';
  const weekdayNames = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const lessonDate = nextLessonDate(lesson);
  const timeLabel = (lesson.startsAt || '') + (lesson.endsAt ? '–' + lesson.endsAt : '');
  return '<section class="panel task-compose task-compose-inline"><div class="task-compose-intro">' +
    '<p class="eyebrow">НОВОЕ ДЗ</p><h2>' + (state.role === 'leader' ? 'Опубликовать ДЗ к этой паре' : 'Предложить ДЗ к этой паре') + '</h2>' +
    '<p class="muted">Домашнее задание будет прикреплено к выбранному занятию.</p></div>' +
    '<div class="task-selected-lesson"><div class="task-selected-lesson-details">' +
    '<div><small>Предмет</small><strong>' + esc(lesson.subject) + '</strong></div>' +
    '<div><small>День</small><strong>' + esc(weekdayNames[lesson.weekday] || '') + '</strong></div>' +
    '<div><small>Дата пары</small><strong>' + esc(dateText(lessonDate)) + '</strong></div>' +
    '<div><small>Время</small><strong>' + esc(timeLabel) + '</strong></div>' +
    '</div></div>' +
    '<form id="task-form" class="form task-form">' +
    '<input type="hidden" name="lessonId" value="' + esc(lesson.id) + '">' +
    '<input type="hidden" name="lessonDate" value="' + lessonDate + '">' +
    '<input type="hidden" name="subject" value="' + esc(lesson.subject) + '">' +
    '<input type="hidden" name="weekday" value="' + Number(lesson.weekday) + '">' +
    '<input type="hidden" name="weekNumber" value="' + Number(lesson.weekNumber) + '">' +
    '<input type="hidden" name="lessonTime" value="' + esc(lesson.startsAt || '') + '">' +
    '<label>Название задания<input name="title" required maxlength="180" placeholder="Что нужно сделать?"></label>' +
    '<label>Описание<textarea name="description" rows="3" placeholder="Дополнительные требования, страницы, вопросы…"></textarea></label>' +
    '<button class="btn primary" type="submit">' + (state.role === 'leader' ? 'Опубликовать' : 'Отправить старосте') + '</button>' +
    '</form></section>';
}

function renderHomeworkPanel() {
  const selectedLesson = state.lessons.find(item => item.id === state.selectedScheduleLessonId) || null;
  const visibleTasks = selectedLesson
    ? state.tasks.filter(item =>
        item.lessonId === selectedLesson.id ||
        (!item.lessonId && item.subject === selectedLesson.subject &&
          item.lessonDate === nextLessonDate(selectedLesson))
      )
    : state.tasks;
  const selectedName = selectedLesson
    ? 'ДЗ · ' + selectedLesson.subject
    : 'ДЗ · Все домашние задания';
  const resetButton = selectedLesson
    ? '<button class="btn ghost homework-reset" type="button" data-action="show-all-homework">Все задания</button>'
    : '';
  const pairLabel = selectedLesson
    ? '<p class="muted homework-context">Показаны задания только к выбранной паре. Нажми другую пару выше, чтобы переключить список.</p>'
    : '<p class="muted homework-context">Выбери пару в расписании выше, чтобы отфильтровать ДЗ по конкретному занятию. Пока показаны все задания группы.</p>';
  const taskContent = visibleTasks.length
    ? taskCards(visibleTasks)
    : empty(selectedLesson ? 'К этой паре пока нет заданий' : 'Пока нет домашних заданий',
        selectedLesson ? 'Староста может опубликовать ДЗ, а студент — предложить его.' : 'Домашние задания, привязанные к парам, появятся здесь.');
  const compose = selectedLesson ? taskForm(selectedLesson) : '';
  return '<section class="homework-section" id="homework-panel"><div class="homework-heading"><div><p class="eyebrow">ПОСЛЕ РАСПИСАНИЯ</p><h2>' + esc(selectedName) + '</h2></div>' + resetButton + '</div>' +
    pairLabel + taskContent + compose + '</section>';
}

function renderTasks() {
  return renderSchedule();
}

function renderModeration() {
  const pending = state.suggestions.filter(item => item.status === 'pending');
  const reviewed = state.suggestions.filter(item => item.status !== 'pending');
  const weekdayNames = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  return heading('ПАНЕЛЬ СТАРОСТЫ', 'Модерация ДЗ', 'Проверь предложения студентов перед публикацией.') +
    (pending.length ? '<div class="moderation">' + pending.map(item => '<article class="panel moderation-card"><div class="meta"><span>' + esc(item.subject || 'Без предмета') + '</span><span>Предложено ' + esc(dateText(item.createdAt)) + '</span></div><h2>' + esc(item.title) + '</h2><p>' + esc(item.description || '') + '</p><div class="meta"><span>Пара: ' + esc([weekdayNames[item.weekday] || '', dateText(item.lessonDate), item.lessonTime || ''].filter(Boolean).join(' · ')) + '</span></div><div class="actions"><button class="btn primary" data-review="approve" data-id="' + esc(item.id) + '">Одобрить и опубликовать</button><button class="btn danger" data-review="reject" data-id="' + esc(item.id) + '">Отклонить</button></div></article>').join('') + '</div>' : empty('Новых предложений нет', 'Когда студент предложит домашнее задание, оно появится здесь.')) +
    (reviewed.length ? '<section class="section"><h2>Рассмотренные предложения</h2><div class="history">' + reviewed.slice(0,8).map(item => '<div><span>' + esc(item.title) + '</span><span class="status ' + item.status + '">' + (item.status === 'approved' ? 'Опубликовано' : 'Отклонено') + '</span></div>').join('') + '</div></section>' : '');
}

const schedulePeriods = [
  { start: '08:30', end: '10:00', label: '1-я пара' },
  { start: '10:30', end: '12:00', label: '2-я пара' },
  { start: '13:00', end: '14:30', label: '3-я пара' },
  { start: '15:00', end: '16:30', label: '4-я пара' }
];

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function closestPeriodIndex(value, field) {
  const minutes = timeToMinutes(value);
  if (minutes === null) return -1;
  let bestIndex = -1;
  let bestDistance = Infinity;
  schedulePeriods.forEach((period, index) => {
    const target = timeToMinutes(period[field]);
    const distance = Math.abs(target - minutes);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestDistance <= 12 ? bestIndex : -1;
}

function lessonStartIndex(lesson) {
  return closestPeriodIndex(lesson.startsAt, 'start');
}

function lessonSpan(lesson, startIndex) {
  const saved = Number(lesson.periodCount);
  if (Number.isInteger(saved) && saved >= 1 && saved <= 4) {
    return Math.min(saved, schedulePeriods.length - startIndex);
  }
  const endIndex = closestPeriodIndex(lesson.endsAt, 'end');
  if (endIndex >= startIndex) return Math.min(endIndex - startIndex + 1, schedulePeriods.length - startIndex);
  return 1;
}

function scheduleLessonCard(lesson, startIndex, span) {
  const periods = schedulePeriods.slice(startIndex, startIndex + span);
  const times = periods.map((period, index) =>
    '<span>' + period.start + '–' + period.end + (span > 1 ? ' · ' + period.label : '') + '</span>'
  ).join('');
  const selected = state.selectedScheduleLessonId === lesson.id;
  return '<article class="schedule-lesson' + (span > 1 ? ' double-period' : '') + (selected ? ' selected-lesson' : '') +
    '" style="grid-row:span ' + span + '" data-schedule-lesson data-id="' + esc(lesson.id) +
    '" role="button" tabindex="0" aria-pressed="' + selected + '" aria-label="Показать задания: ' + esc(lesson.subject) + '">' +
    '<div class="schedule-times">' + times + '</div>' +
    '<strong>' + esc(lesson.subject) + '</strong>' +
    (lesson.room ? '<small class="schedule-room">' + esc(lesson.room) + '</small>' : '') +
    (lesson.description ? '<p class="schedule-description">' + esc(lesson.description) + '</p>' : '') +
    '<small class="schedule-task-hint">' + (selected ? 'Задания выбраны ниже' : 'Нажми, чтобы увидеть ДЗ') + '</small>' +
    (state.role === 'leader' ? '<button type="button" class="lesson-delete" title="Удалить пару" aria-label="Удалить пару" data-action="delete-lesson" data-id="' + esc(lesson.id) + '">×</button>' : '') +
    '</article>';
}

function renderScheduleDay(weekNumber, weekday, todayInfo, tomorrowInfo) {
  const names = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const lessons = state.lessons
    .filter(item => Number(item.weekNumber) === weekNumber && Number(item.weekday) === weekday)
    .map(item => ({ ...item, startIndex: lessonStartIndex(item) }))
    .sort((a,b) => a.startIndex - b.startIndex || String(a.startsAt).localeCompare(String(b.startsAt)));
  const occupied = new Set();
  const byStart = new Map();
  lessons.filter(item => item.startIndex >= 0).forEach(item => {
    if (!byStart.has(item.startIndex)) byStart.set(item.startIndex, []);
    byStart.get(item.startIndex).push(item);
  });

  const slotMarkup = [];
  for (let slot = 0; slot < schedulePeriods.length;) {
    const items = byStart.get(slot) || [];
    const available = items.filter(item => {
      const span = lessonSpan(item, slot);
      return !Array.from({length:span}, (_,offset)=>slot+offset).some(index=>occupied.has(index));
    });
    if (available.length) {
      available.forEach((item, index) => {
        const span = index === 0 && available.length === 1 ? lessonSpan(item, slot) : 1;
        slotMarkup.push(scheduleLessonCard(item, slot, span));
        for (let offset = 0; offset < span; offset++) occupied.add(slot + offset);
      });
      slot++;
      while (slot < schedulePeriods.length && occupied.has(slot)) slot++;
    } else {
      const period = schedulePeriods[slot];
      const editing = state.scheduleEditorSlot &&
        Number(state.scheduleEditorSlot.weekNumber) === weekNumber &&
        Number(state.scheduleEditorSlot.weekday) === weekday &&
        Number(state.scheduleEditorSlot.periodIndex) === slot;
      if (editing && state.role === 'leader') {
        const maxDuration = Math.min(3, schedulePeriods.length - slot);
        const durationOptions = Array.from({ length: maxDuration }, (_, index) =>
          '<option value="' + (index + 1) + '">' + (index === 0 ? 'Одна пара' : (index + 1) + ' пары подряд') + '</option>'
        ).join('');
        slotMarkup.push(
          '<div class="schedule-cell-editor">' +
            '<div class="schedule-cell-editor-top"><span>' + period.start + '–' + period.end + '</span><strong>Новая пара</strong></div>' +
            '<form id="lesson-form" class="schedule-inline-form">' +
              '<input type="hidden" name="weekNumber" value="' + weekNumber + '">' +
              '<input type="hidden" name="weekday" value="' + weekday + '">' +
              '<input type="hidden" name="startPeriod" value="' + slot + '">' +
              '<label>Предмет<input name="subject" required maxlength="120" placeholder="Название предмета"></label>' +
              '<div class="schedule-inline-options">' +
                '<label>Длительность<select name="periodCount">' + durationOptions + '</select></label>' +
                '<label>Аудитория<input name="room" maxlength="60" placeholder="Ауд."></label>' +
              '</div>' +
              '<label>ДЗ / примечание<input name="description" maxlength="220" placeholder="Что подготовить"></label>' +
              '<div class="schedule-inline-actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn ghost" type="button" data-action="cancel-lesson-cell">Отмена</button></div>' +
            '</form>' +
          '</div>'
        );
      } else {
        slotMarkup.push(
          '<div class="schedule-empty-slot' + (state.role === 'leader' ? ' schedule-addable' : '') + '">' +
            '<span>' + period.start + '–' + period.end + '</span><small>Свободно</small>' +
            (state.role === 'leader' ? '<button type="button" class="schedule-add-trigger" data-action="open-lesson-cell" data-week="' + weekNumber + '" data-day="' + weekday + '" data-period="' + slot + '">＋ Добавить пару</button>' : '') +
          '</div>'
        );
      }
      slot++;
    }
  }

  const outside = lessons.filter(item => item.startIndex < 0);
  const dateClass = todayInfo.weekNumber === weekNumber && todayInfo.weekday === weekday
    ? ' is-today'
    : (tomorrowInfo.weekNumber === weekNumber && tomorrowInfo.weekday === weekday ? ' is-tomorrow' : '');
  const badge = dateClass.includes('is-today') ? '<span class="day-badge today-badge">Сегодня</span>'
    : (dateClass.includes('is-tomorrow') ? '<span class="day-badge tomorrow-badge">Завтра</span>' : '');
  return '<article class="schedule-day' + dateClass + '">' +
    '<header class="schedule-day-header"><strong>' + names[weekday] + '</strong>' + badge + '</header>' +
    '<div class="schedule-slots">' + slotMarkup.join('') + '</div>' +
    (outside.length ? '<div class="schedule-unplaced">' + outside.map(item => scheduleLessonCard(item, 0, 1)).join('') + '</div>' : '') +
    '</article>';
}

function localDateParts(date) {
  return {
    iso: [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-'),
    weekday: ((date.getDay() + 6) % 7) + 1,
    label: date.toLocaleDateString('ru-RU', { weekday:'long', day:'numeric', month:'long' })
  };
}

function renderSchedule() {
  const todayDate = new Date();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const todayInfo = { ...localDateParts(todayDate), weekNumber: lessonWeekFor(localDateParts(todayDate).iso) };
  const tomorrowInfo = { ...localDateParts(tomorrowDate), weekNumber: lessonWeekFor(localDateParts(tomorrowDate).iso) };
  const currentWeek = todayInfo.weekNumber;
  const nextWeek = currentWeek === 1 ? 2 : 1;
  const weekNames = {1:'Первая',2:'Вторая'};
  const weekSummary = '<div class="schedule-summary">' +
    '<article><small>ТЕКУЩАЯ УЧЕБНАЯ НЕДЕЛЯ</small><strong>' + weekNames[currentWeek] + '</strong></article>' +
    '<article><small>СЛЕДУЮЩАЯ УЧЕБНАЯ НЕДЕЛЯ</small><strong>' + weekNames[nextWeek] + '</strong></article>' +
    '<article class="date-highlight today-highlight"><small>СЕГОДНЯ</small><strong>' + esc(todayInfo.label) + '</strong></article>' +
    '<article class="date-highlight tomorrow-highlight"><small>ЗАВТРА</small><strong>' + esc(tomorrowInfo.label) + '</strong></article>' +
    '</div>';
  const weeks = [1,2].map(week => '<section class="schedule-week"><div class="schedule-week-title"><p class="eyebrow">' + weekNames[week] + ' УЧЕБНАЯ НЕДЕЛЯ</p></div><div class="schedule-grid">' +
    [1,2,3,4,5,6].map(day => renderScheduleDay(week, day, todayInfo, tomorrowInfo)).join('') +
    '</div></section>').join('');
  const hint = state.role === 'leader'
    ? 'Нажми на пару, чтобы увидеть связанные с ней задания. Для добавления занятия наведи курсор на свободную ячейку.'
    : 'Нажми на пару, чтобы увидеть домашние задания именно к этому занятию.';
  return heading('УЧЕБНЫЙ ПРОЦЕСС', 'Расписание и домашние задания', hint) +
    weekSummary + weeks + renderHomeworkPanel();
}

function lessonWeekFor(date) {
  const [sy,sm,sd] = (state.group.studyCycleStart || today()).split('-').map(Number);
  const [y,m,d] = date.split('-').map(Number);
  const start = Date.UTC(sy,sm-1,sd);
  const target = Date.UTC(y,m-1,d);
  const weeks = Math.floor((target - start) / 604800000);
  return ((weeks % 2) + 2) % 2 + 1;
}

function nextLessonDate(lesson) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const currentWeekday = ((candidate.getDay() + 6) % 7) + 1;
  const targetWeekday = Number(lesson.weekday);
  const daysAhead = (targetWeekday - currentWeekday + 7) % 7;
  candidate.setDate(candidate.getDate() + daysAhead);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const lessonMinutes = timeToMinutes(lesson.startsAt);
  if (daysAhead === 0 && lessonMinutes !== null && currentMinutes >= lessonMinutes) {
    candidate.setDate(candidate.getDate() + 7);
  }

  const toISO = value => [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')
  ].join('-');
  if (lessonWeekFor(toISO(candidate)) !== Number(lesson.weekNumber)) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return toISO(candidate);
}

function attendanceResponseLabel(response) {
  if (response === 'will_attend') return '<span class="attendance-response will-attend">Будет на паре</span>';
  if (response === 'will_miss') return '<span class="attendance-response will-miss">Не будет</span>';
  return '<span class="attendance-response no-response">Нет ответа</span>';
}

function attendanceStatusLabel(status) {
  return ({ present: 'Был', absent: 'Неуваж.', excused: 'Уваж.', late: 'Опоздал' })[status] || 'Не отмечен';
}

function renderAttendanceRoster(lesson) {
  const members = state.groupMembers.slice().sort((a,b) =>
    String(a.displayName || a.fullName || a.username || '').localeCompare(
      String(b.displayName || b.fullName || b.username || ''), 'ru', { sensitivity: 'base' }
    )
  );
  const responses = new Map(state.attendance
    .filter(item => item.lessonId === lesson.id && item.lessonDate === state.attendanceDate)
    .map(item => [item.userId, item]));
  const records = new Map(state.attendanceRecords
    .filter(item => item.lessonId === lesson.id && item.lessonDate === state.attendanceDate)
    .map(item => [item.studentId, item]));
  const missed = members.filter(member => responses.get(member.id)?.response === 'will_miss');
  const counts = {
    present: members.filter(member => records.get(member.id)?.status === 'present').length,
    absent: members.filter(member => records.get(member.id)?.status === 'absent').length,
    excused: members.filter(member => records.get(member.id)?.status === 'excused').length
  };
  const bulkButton = missed.length
    ? '<button class="attendance-bulk-excuse" type="button" data-action="excuse-all-missed" data-lesson="' + esc(lesson.id) + '">Поставить «Уваж.» всем, кто ответил «Не буду» (' + missed.length + ')</button>'
    : '';

  const rows = members.map(member => {
    const userId = member.id || member.userId;
    const name = member.displayName || member.fullName || member.username || 'Участник';
    const response = responses.get(userId)?.response || '';
    const status = records.get(userId)?.status || '';
    const role = member.role === 'leader' ? '<span class="roster-role">Староста</span>' : '';
    const responseText = response === 'will_attend' ? 'Ответ: будет на паре'
      : (response === 'will_miss' ? 'Ответ: не будет на паре' : 'Ответ: пока не дан');
    const responseClass = response === 'will_attend' ? ' positive'
      : (response === 'will_miss' ? ' negative' : '');
    const lateNote = status === 'late' ? '<span class="roster-late-note">Последняя отметка: опоздал</span>' : '';
    const mark = (value, label, cls) =>
      '<button type="button" class="attendance-mark ' + cls + (status === value ? ' active' : '') +
      '" data-official-status="' + value + '" data-student="' + esc(userId) +
      '" data-lesson="' + esc(lesson.id) + '" aria-pressed="' + (status === value) + '">' + label + '</button>';
    return '<article class="attendance-person-row"><div class="attendance-person-info"><strong>' + esc(name) + '</strong>' + role +
      '<small class="attendance-person-response' + responseClass + '">' + responseText + '</small>' + lateNote + '</div>' +
      '<div class="attendance-mark-buttons">' +
      mark('present', 'Был', 'mark-present') +
      mark('absent', 'Неуваж.', 'mark-absent') +
      mark('excused', 'Уваж.', 'mark-excused') +
      '</div></article>';
  }).join('');

  return '<section class="attendance-register"><div class="attendance-register-head"><div><p class="eyebrow">ОФИЦИАЛЬНЫЙ ЖУРНАЛ</p><h2>' + esc(lesson.subject) + '</h2><p class="muted">' + esc(lesson.startsAt || '') + (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') + ' · ' + esc(dateText(state.attendanceDate)) + '</p></div>' +
    '<div class="attendance-register-count">' + members.length + ' чел.</div></div>' +
    '<div class="attendance-register-summary"><span>Был: <b>' + counts.present + '</b></span><span>Неуваж.: <b>' + counts.absent + '</b></span><span>Уваж.: <b>' + counts.excused + '</b></span></div>' +
    (bulkButton ? '<div class="attendance-bulk-row">' + bulkButton + '</div>' : '') +
    (rows ? '<div class="attendance-roster">' + rows + '</div>' : empty('В группе пока нет участников', 'Когда студенты вступят в группу, они появятся здесь.')) +
    '<p class="muted small attendance-register-footnote">Ответ «Будет / Не будет» оставляет студент. Кнопки справа — официальная отметка старосты. Повторное нажатие снимает отметку.</p></section>';
}

function renderStudentAttendance(lessons, date) {
  const profileName = displayFullName(state.profile);
  const [year, month, day] = date.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day, 12);
  const dateLabel = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const weekdayLabel = dateObj.toLocaleDateString('ru-RU', { weekday: 'long' });
  const responseMap = new Map(state.attendance.map(item => [item.lessonId, item.response]));
  const attendedCount = lessons.filter(item => responseMap.get(item.id) === 'will_attend').length;
  const missedCount = lessons.filter(item => responseMap.get(item.id) === 'will_miss').length;
  const allAttend = lessons.length > 0 && attendedCount === lessons.length;
  const allMiss = lessons.length > 0 && missedCount === lessons.length;
  const quick = lessons.length
    ? '<div class="attendance-all-actions">' +
      '<button type="button" class="attendance-all-button' + (allAttend ? ' active' : '') + '" data-attendance-all="will_attend">Буду на всех парах</button>' +
      '<button type="button" class="attendance-all-button' + (allMiss ? ' active' : '') + '" data-attendance-all="will_miss">Не буду на всех парах</button>' +
      '</div>' : '';
  const cards = lessons.map((lesson,index) => {
    const response = responseMap.get(lesson.id) || '';
    return '<article class="student-attendance-lesson"><div class="student-attendance-lesson-title"><div>' +
      '<small>' + (index + 1) + ' пара · ' + esc(lesson.startsAt || '') + (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') + '</small>' +
      '<h2>' + esc(lesson.subject) + '</h2>' + (lesson.room ? '<p>' + esc(lesson.room) + '</p>' : '') +
      '</div>' + (response ? attendanceResponseLabel(response) : '') + '</div>' +
      '<div class="student-attendance-lesson-actions">' +
      '<button type="button" class="attendance-choice' + (response === 'will_attend' ? ' active attend' : '') + '" data-attendance="will_attend" data-lesson="' + esc(lesson.id) + '">Буду</button>' +
      '<button type="button" class="attendance-choice' + (response === 'will_miss' ? ' active miss' : '') + '" data-attendance="will_miss" data-lesson="' + esc(lesson.id) + '">Не буду</button>' +
      '</div></article>';
  }).join('');
  return '<section class="student-attendance-page"><header class="student-attendance-header"><div><h1>' + esc(profileName) + '</h1><p>' + esc(dateLabel) + ', ' + esc(weekdayLabel) + '</p></div>' +
    '<div class="student-attendance-date"><label for="attendance-date">Дата</label><input type="date" id="attendance-date" value="' + date + '"></div></header>' +
    '<p class="student-attendance-caption">Отметь, будешь ли ты на занятиях. Староста увидит твой ответ.</p>' + quick +
    (lessons.length ? '<div class="student-attendance-lessons">' + cards + '</div>' : empty('На эту дату пар нет', 'Выбери другую дату или проверь расписание группы.')) +
    '</section>';
}

function renderAttendance() {
  const date = state.attendanceDate;
  const [y,m,d] = date.split('-').map(Number);
  const weekday = ((new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7)+1;
  const week = lessonWeekFor(date);
  const lessons = state.lessons.filter(item => Number(item.weekday) === weekday && Number(item.weekNumber) === week)
    .sort((a,b) => String(a.startsAt).localeCompare(String(b.startsAt)));

  if (state.role !== 'leader') {
    return renderStudentAttendance(lessons, date);
  }

  const selected = lessons.find(item => item.id === state.selectedAttendanceLessonId) || null;
  const cards = lessons.map((lesson,index) => {
    const responses = state.attendance.filter(item => item.lessonId === lesson.id && item.lessonDate === date);
    const attending = responses.filter(item => item.response === 'will_attend').length;
    const missing = responses.filter(item => item.response === 'will_miss').length;
    return '<button type="button" class="attendance-lesson-card' + (selected?.id === lesson.id ? ' selected' : '') +
      '" data-attendance-lesson="' + esc(lesson.id) + '"><span>' + (index + 1) + ' пара · ' +
      esc(lesson.startsAt || '') + (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') +
      '</span><strong>' + esc(lesson.subject) + '</strong><small>Будут: ' + attending + ' · Не будут: ' + missing + '</small></button>';
  }).join('');
  const [year,month,day] = date.split('-').map(Number);
  const dateLabel = new Date(year,month-1,day,12).toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'long'});
  return heading('ПОСЕЩАЕМОСТЬ', 'Журнал старосты', 'Выбери пару и отмечай посещаемость по списку группы.') +
    '<div class="date-picker attendance-date-leader"><label>Дата<input type="date" id="attendance-date" value="' + date + '"></label><span>' + esc(dateLabel) + ' · ' + (week === 1 ? 'Первая' : 'Вторая') + ' учебная неделя</span></div>' +
    (lessons.length ? '<div class="attendance-lesson-grid">' + cards + '</div>' : empty('На эту дату пар нет', 'Выбери другую дату или проверь расписание группы.')) +
    (selected ? renderAttendanceRoster(selected) : (lessons.length ? '<p class="muted small attendance-pick-hint">Нажми на пару выше — откроется список группы по алфавиту.</p>' : ''));
}

async function saveAttendance(lessonId, response) {
  const responseId = lessonId + '_' + state.attendanceDate + '_' + state.user.uid;
  const responseRef = doc(db, 'groups', state.group.id, 'attendanceResponses', responseId);
  setBusy(true);
  try {
    await setDoc(responseRef, {
      lessonId,
      userId: state.user.uid,
      lessonDate: state.attendanceDate,
      response,
      updatedAt: serverTimestamp()
    }, { merge: true });
    notify('Предварительный ответ сохранён.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось сохранить ответ.', 'error');
  } finally {
    setBusy(false);
  }
}

async function saveAttendanceForAll(response) {
  if (state.role === 'leader') return;
  const [y,m,d] = state.attendanceDate.split('-').map(Number);
  const weekday = ((new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7)+1;
  const week = lessonWeekFor(state.attendanceDate);
  const lessons = state.lessons.filter(item => Number(item.weekday) === weekday && Number(item.weekNumber) === week);
  if (!lessons.length) return notify('На эту дату пар нет.');
  setBusy(true);
  try {
    const batch = writeBatch(db);
    lessons.forEach(lesson => {
      const responseId = lesson.id + '_' + state.attendanceDate + '_' + state.user.uid;
      batch.set(doc(db, 'groups', state.group.id, 'attendanceResponses', responseId), {
        lessonId: lesson.id,
        userId: state.user.uid,
        lessonDate: state.attendanceDate,
        response,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });
    await batch.commit();
    notify(response === 'will_attend' ? 'Отмечено: буду на всех парах.' : 'Отмечено: не буду на всех парах.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось сохранить ответы на все пары.', 'error');
  } finally {
    setBusy(false);
  }
}

function attendanceRecordRef(lessonId, studentId) {
  const recordId = lessonId + '_' + state.attendanceDate + '_' + studentId;
  return doc(db, 'groups', state.group.id, 'attendanceRecords', recordId);
}

async function saveOfficialAttendance(studentId, lessonId, status) {
  if (state.role !== 'leader') return;
  const ref = attendanceRecordRef(lessonId, studentId);
  setBusy(true);
  try {
    if (!status) {
      await deleteDoc(ref);
      notify('Официальная отметка очищена.', 'success');
    } else {
      await setDoc(ref, {
        studentId,
        lessonId,
        lessonDate: state.attendanceDate,
        status,
        reason: status === 'excused' ? 'Уважительная причина' : '',
        markedBy: state.user.uid,
        markedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      notify('Отметка посещаемости сохранена.', 'success');
    }
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось сохранить официальную отметку.', 'error');
  } finally {
    setBusy(false);
  }
}

async function excuseMissedStudents(lessonId, onlyStudentId = null) {
  if (state.role !== 'leader') return;
  const missing = state.attendance.filter(item =>
    item.lessonId === lessonId &&
    item.lessonDate === state.attendanceDate &&
    item.response === 'will_miss' &&
    (!onlyStudentId || item.userId === onlyStudentId)
  );
  if (!missing.length) {
    notify('Нет студентов с ответом «Не буду».');
    return;
  }
  const title = onlyStudentId
    ? 'Поставить этому студенту «Уважительная причина»?'
    : 'Поставить «Уважительная причина» всем ' + missing.length + ' студентам, ответившим «Не буду»?';
  if (!window.confirm(title)) return;

  setBusy(true);
  try {
    for (let offset = 0; offset < missing.length; offset += 450) {
      const batch = writeBatch(db);
      missing.slice(offset, offset + 450).forEach(item => {
        batch.set(attendanceRecordRef(lessonId, item.userId), {
          studentId: item.userId,
          lessonId,
          lessonDate: state.attendanceDate,
          status: 'excused',
          reason: 'Уважительная причина — предварительный ответ «Не буду»',
          markedBy: state.user.uid,
          markedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
    }
    notify('Уважительная причина отмечена.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось обновить посещаемость.', 'error');
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  root.addEventListener('click', async event => {
    const button = event.target.closest('button,[data-schedule-lesson]');
    if (!button) return;
    if (button.dataset.mode) return renderAuth(button.dataset.mode);
    if (button.dataset.tab) { state.tab = button.dataset.tab; return renderWorkspace(); }
    if (button.dataset.action === 'logout') return doSignOut();
    if (button.dataset.action === 'menu') { document.querySelector('.sidebar')?.classList.toggle('open'); return; }

    if (button.dataset.scheduleLesson !== undefined) {
      state.selectedScheduleLessonId = button.dataset.id;
      renderWorkspace();
      root.querySelector('#homework-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (button.dataset.action === 'show-all-homework') {
      state.selectedScheduleLessonId = null;
      renderWorkspace();
      root.querySelector('#homework-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (button.dataset.attendanceLesson) {
      state.selectedAttendanceLessonId = button.dataset.attendanceLesson;
      renderWorkspace();
      root.querySelector('.attendance-register')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (button.dataset.attendanceAll) return saveAttendanceForAll(button.dataset.attendanceAll);
    if (button.dataset.officialStatus) {
      const current = state.attendanceRecords.find(item =>
        item.studentId === button.dataset.student &&
        item.lessonId === button.dataset.lesson &&
        item.lessonDate === state.attendanceDate
      );
      const status = current?.status === button.dataset.officialStatus ? '' : button.dataset.officialStatus;
      return saveOfficialAttendance(button.dataset.student, button.dataset.lesson, status);
    }
    if (button.dataset.action === 'excuse-all-missed') return excuseMissedStudents(button.dataset.lesson);
    if (button.dataset.attendance) return saveAttendance(button.dataset.lesson, button.dataset.attendance);

    if (button.dataset.action === 'open-lesson-cell') {
      state.scheduleEditorSlot = {
        weekNumber: Number(button.dataset.week),
        weekday: Number(button.dataset.day),
        periodIndex: Number(button.dataset.period)
      };
      renderWorkspace();
      root.querySelector('#lesson-form input[name="subject"]')?.focus();
      return;
    }
    if (button.dataset.action === 'cancel-lesson-cell') {
      state.scheduleEditorSlot = null;
      renderWorkspace();
      return;
    }
    if (button.dataset.action === 'delete-lesson') return deleteLesson(button.dataset.id);
    if (button.dataset.action === 'copy-code') {
      try { await navigator.clipboard.writeText(state.activeMembership.inviteCode); notify('Код скопирован.', 'success'); }
      catch { notify('Код приглашения: ' + state.activeMembership.inviteCode); }
      return;
    }
    if (button.dataset.review) return reviewSuggestion(button.dataset.id, button.dataset.review === 'approve');
  });

  root.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('form')) return;
    event.preventDefault();
    if (form.id === 'auth-form') return submitAuth(form);
    if (form.id === 'create-group') return createGroup(form);
    if (form.id === 'join-group') return joinGroup(form);
    if (form.id === 'task-form') return submitTask(form);
    if (form.id === 'lesson-form') return submitLesson(form);
    if (form.id === 'cycle-form') return saveCycle(form);
  });

  root.addEventListener('change', async event => {
    if (event.target.matches('[data-progress]')) return updateProgress(event.target);
    if (event.target.id === 'attendance-date' && event.target.value) {
      state.attendanceDate = event.target.value;
      state.selectedAttendanceLessonId = null;
      try { await loadWorkspace(); renderWorkspace(); }
      catch (error) { notify(error.message, 'error'); }
    }
    if (event.target.id === 'group-switch') {
      try { await selectGroup(event.target.value); }
      catch (error) { notify(error.message, 'error'); }
    }
  });
}

async function saveCycle(form) {
  const value = new FormData(form).get('studyCycleStart');
  if (!value) return;
  const date = new Date(value + 'T00:00:00');
  if (date.getDay() !== 1) return notify('Выбери понедельник.', 'error');
  setBusy(true);
  try {
    await updateDoc(doc(db, 'groups', state.group.id), {
      studyCycleStart: value,
      updatedAt: serverTimestamp()
    });
    state.group.studyCycleStart = value;
    notify('Учебный цикл сохранён.', 'success');
  } catch (error) {
    notify(error.message || 'Не удалось сохранить учебный цикл.', 'error');
  } finally {
    setBusy(false);
  }
}

async function doSignOut() {
  setBusy(true);
  try {
    await signOut(auth);
    state.user = null;
    state.group = null;
    state.activeMembership = null;
    renderAuth();
  } catch (error) {
    notify(error.message || 'Не удалось выйти.', 'error');
  } finally {
    setBusy(false);
  }
}

function start() {
  bindEvents();
  if (!firebaseConfigured) return renderSetup();
  onAuthStateChanged(auth, async user => {
    try {
      await boot(user);
    } catch (error) {
      console.error(error);
      if (error.code === 'permission-denied') {
        renderAuth('login', 'Вход выполнен, но Firestore отклонил доступ. ' + (error.message || 'Проверь опубликованные правила Firestore.'));
      } else {
        renderAuth('login', 'Не удалось загрузить данные: ' + (error.message || 'неизвестная ошибка'));
      }
    }
  });
}

start();
