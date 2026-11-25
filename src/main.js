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
  attendanceDate: today(),
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
  frame('<main class="auth"><section class="auth-intro"><div class="monogram">S</div><p class="eyebrow">YOUR ACADEMIC SPACE</p><h1>STUDIUM</h1><p>Всё важное для учёбы — в одном пространстве.</p><div class="ornament">— ✦ —</div></section><section class="panel auth-panel"><div class="switch"><button type="button" data-mode="login" class="' + (!signup ? 'active' : '') + '">Войти</button><button type="button" data-mode="signup" class="' + (signup ? 'active' : '') + '">Регистрация</button></div><h2>' + (signup ? 'Создать аккаунт' : 'С возвращением') + '</h2><p class="muted">' + (message ? esc(message) : (signup ? 'Создай аккаунт, чтобы присоединиться к своей группе.' : 'Войди в своё учебное пространство.')) + '</p><form id="auth-form" class="form">' + (signup ? '<label>Имя и фамилия<input name="full_name" minlength="2" maxlength="80" autocomplete="name" required placeholder="Александр Иванов"></label><label>Отчество <span class="muted">(необязательно)</span><input name="patronymic" maxlength="80" autocomplete="additional-name" placeholder="Александрович"></label>' : '') + '<label>Логин<input name="username" type="text" minlength="3" maxlength="24" autocapitalize="none" spellcheck="false" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,23}" required placeholder="student_01"><small class="muted">3–24 символа: латинские буквы, цифры, точка, дефис или подчёркивание.</small></label><label>Пароль<input name="password" type="password" minlength="8" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" required placeholder="Не менее 8 символов"></label><button class="btn primary" type="submit">' + (signup ? 'Создать аккаунт' : 'Войти') + '</button></form><p class="foot muted">STUDIUM · учебное пространство твоей группы</p></section></main>');
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

async function boot(user = auth.currentUser) {
  if (!firebaseConfigured) return renderSetup();
  state.user = user || null;
  if (!state.user) {
    state.profile = null;
    state.group = null;
    state.memberships = [];
    return renderAuth(state.authMode || 'login');
  }

  await ensureProfile(state.user);
  await loadMemberships();

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
  const groupSnapshot = await getDoc(doc(db, 'groups', groupId));
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
  const base = collection(db, 'groups', gid);
  const tasksRef = collection(base, 'tasks');
  const lessonsRef = collection(base, 'lessons');
  const suggestionsRef = collection(base, 'taskSuggestions');
  const progressRef = collection(base, 'taskProgress');
  const attendanceRef = collection(base, 'attendanceResponses');

  const taskQuery = query(tasksRef, orderBy('dueDate', 'asc'));
  const lessonQuery = query(lessonsRef, orderBy('weekday', 'asc'), orderBy('weekNumber', 'asc'), orderBy('startsAt', 'asc'));
  const suggestionQuery = state.role === 'leader'
    ? query(suggestionsRef, where('status', '==', 'pending'), orderBy('createdAt', 'desc'))
    : query(suggestionsRef, where('submittedBy', '==', state.user.uid), orderBy('createdAt', 'desc'));
  const progressQuery = query(progressRef, where('userId', '==', state.user.uid));
  const attendanceConstraints = [where('lessonDate', '==', state.attendanceDate)];
  if (state.role !== 'leader') attendanceConstraints.push(where('userId', '==', state.user.uid));
  const attendanceQuery = query(attendanceRef, ...attendanceConstraints);

  const [tasks, suggestions, lessons, progress, attendance] = await Promise.all([
    getDocs(taskQuery), getDocs(suggestionQuery), getDocs(lessonQuery),
    getDocs(progressQuery), getDocs(attendanceQuery)
  ]);

  state.tasks = tasks.docs.map(item => ({ id: item.id, ...item.data() }));
  state.suggestions = suggestions.docs.map(item => ({ id: item.id, ...item.data() }));
  state.lessons = lessons.docs.map(item => ({ id: item.id, ...item.data() }));
  state.progress = new Map(progress.docs.map(item => [item.data().taskId, item.data().completed === true]));
  state.attendance = attendance.docs.map(item => ({ id: item.id, ...item.data() }));
}

function navButton(tab, icon, title) {
  return '<button type="button" class="' + (state.tab === tab ? 'active' : '') + '" data-tab="' + tab + '"><span>' + icon + '</span>' + title + '</button>';
}

function renderWorkspace() {
  const leader = state.role === 'leader';
  const name = displayFullName(state.profile);
  const tabs = [
    navButton('overview', '⌂', 'Обзор'),
    navButton('tasks', '✓', 'Домашние задания'),
    ...(leader ? [navButton('moderation', '◇', 'Модерация <b>' + state.suggestions.filter(item => item.status === 'pending').length + '</b>')] : []),
    navButton('schedule', '▦', 'Расписание'),
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
  if (state.tab === 'tasks') return renderTasks();
  if (state.tab === 'moderation' && state.role === 'leader') return renderModeration();
  if (state.tab === 'schedule') return renderSchedule();
  if (state.tab === 'attendance') return renderAttendance();
  if (state.tab === 'library') return heading('БИБЛИОТЕКА', 'Материалы', 'Методички, ссылки, презентации и лекции.') +
    '<div class="grid-two"><article class="panel"><h2>Материалы группы</h2><p class="muted">Подключение файлов через Firebase Storage — следующий этап.</p></article><article class="panel"><h2>Лекции</h2><p class="muted">Отдельная библиотека лекций будет подключена к Firestore и Storage.</p></article></div>';
  if (state.tab === 'manage') return renderManage();
  return renderOverview();
}

function renderOverview() {
  const pending = state.suggestions.filter(item => item.status === 'pending').length;
  const completed = state.tasks.filter(item => state.progress.get(item.id)).length;
  const nextTask = state.tasks.find(item => item.dueDate);
  return heading('STUDIUM / ОБЗОР', 'Добро пожаловать', esc(displayFullName(state.profile)), '<button class="btn primary" data-tab="tasks">Открыть задания →</button>') +
    '<div class="stats"><article><small>Заданий в группе</small><strong>' + state.tasks.length + '</strong></article><article><small>Выполнено тобой</small><strong>' + completed + '</strong></article><article><small>Ближайший дедлайн</small><strong class="date-stat">' + esc(dateText(nextTask?.dueDate)) + '</strong></article><article><small>На модерации</small><strong>' + (state.role === 'leader' ? pending : '—') + '</strong></article></div>' +
    '<section class="section"><div class="section-title"><h2>Ближайшие задания</h2><button class="text-btn" data-tab="tasks">Все задания →</button></div>' + taskCards(state.tasks.slice(0,3)) + '</section>';
}

function taskCards(items) {
  if (!items.length) return empty('Пока нет заданий', 'Добавь задание или предложи его старосте.');
  return '<div class="task-list">' + items.map(task => {
    const done = state.progress.get(task.id) === true;
    return '<article class="task-card ' + (done ? 'done' : '') + '"><div class="task-copy"><small>' + esc(task.subject || 'Без предмета') + '</small><h3>' + esc(task.title) + '</h3><p>' + esc(task.description || '') + '</p><div class="meta"><span>Срок: ' + esc(dateText(task.dueDate)) + '</span></div></div><label class="check"><input type="checkbox" data-progress="' + esc(task.id) + '" ' + (done ? 'checked' : '') + '> Выполнено</label></article>';
  }).join('') + '</div>';
}

function taskForm() {
  return '<section class="panel compose"><div><p class="eyebrow">НОВОЕ ЗАДАНИЕ</p><h2>' + (state.role === 'leader' ? 'Опубликовать ДЗ' : 'Предложить ДЗ') + '</h2><p class="muted">' + (state.role === 'leader' ? 'Задание сразу появится у всей группы.' : 'Староста проверит описание и опубликует задание для группы.') + '</p></div><form id="task-form" class="form"><div class="two"><label>Предмет<input name="subject" maxlength="120" placeholder="Например, Анатомия"></label><label>Дата пары<input name="lessonDate" type="date"></label></div><label>Название задания<input name="title" required maxlength="180" placeholder="Что нужно сделать?"></label><label>Описание<textarea name="description" rows="3" placeholder="Дополнительные требования, страницы, вопросы…"></textarea></label><label>Срок выполнения<input name="dueDate" type="date"></label><button class="btn primary">' + (state.role === 'leader' ? 'Опубликовать' : 'Отправить старосте') + '</button></form></section>';
}

function renderTasks() {
  return heading('УЧЕБНЫЙ ПРОЦЕСС', 'Домашние задания', 'Общий список группы и твой персональный прогресс.') + taskForm() + taskCards(state.tasks);
}

function renderModeration() {
  const pending = state.suggestions.filter(item => item.status === 'pending');
  const reviewed = state.suggestions.filter(item => item.status !== 'pending');
  return heading('ПАНЕЛЬ СТАРОСТЫ', 'Модерация ДЗ', 'Проверь предложения студентов перед публикацией.') +
    (pending.length ? '<div class="moderation">' + pending.map(item => '<article class="panel moderation-card"><div class="meta"><span>' + esc(item.subject || 'Без предмета') + '</span><span>Предложено ' + esc(dateText(item.createdAt)) + '</span></div><h2>' + esc(item.title) + '</h2><p>' + esc(item.description || '') + '</p><div class="meta"><span>Пара: ' + esc(dateText(item.lessonDate)) + '</span><span>Срок: ' + esc(dateText(item.dueDate)) + '</span></div><div class="actions"><button class="btn primary" data-review="approve" data-id="' + esc(item.id) + '">Одобрить и опубликовать</button><button class="btn danger" data-review="reject" data-id="' + esc(item.id) + '">Отклонить</button></div></article>').join('') + '</div>' : empty('Новых предложений нет', 'Когда студент предложит домашнее задание, оно появится здесь.')) +
    (reviewed.length ? '<section class="section"><h2>Рассмотренные предложения</h2><div class="history">' + reviewed.slice(0,8).map(item => '<div><span>' + esc(item.title) + '</span><span class="status ' + item.status + '">' + (item.status === 'approved' ? 'Опубликовано' : 'Отклонено') + '</span></div>').join('') + '</div></section>' : '');
}

function renderSchedule() {
  const days = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const add = state.role === 'leader' ? '<button class="btn primary" data-action="show-lesson">＋ Добавить пару</button>' : '';
  const rows = state.lessons.map(item => '<article class="lesson"><time>' + esc(item.startsAt) + (item.endsAt ? '–' + esc(item.endsAt) : '') + '</time><div><small>' + days[item.weekday] + ' · ' + (item.weekNumber === 2 ? 'II неделя' : 'I неделя') + '</small><strong>' + esc(item.subject) + '</strong><p>' + esc(item.room || 'Аудитория не указана') + '</p></div></article>').join('');
  return heading('РАСПИСАНИЕ', 'Занятия группы', 'Расписание на чередующиеся учебные недели.', add) +
    (state.role === 'leader' ? '<section class="panel inline-form hidden" id="lesson-editor"><form id="lesson-form" class="form"><h2>Новая пара</h2><label>Предмет<input name="subject" required maxlength="120"></label><div class="two"><label>День<select name="weekday"><option value="1">Понедельник</option><option value="2">Вторник</option><option value="3">Среда</option><option value="4">Четверг</option><option value="5">Пятница</option><option value="6">Суббота</option></select></label><label>Неделя<select name="weekNumber"><option value="1">Первая</option><option value="2">Вторая</option></select></label></div><div class="two"><label>Начало<input name="startsAt" type="time" value="08:30" required></label><label>Конец<input name="endsAt" type="time" value="10:05"></label></div><label>Аудитория<input name="room" maxlength="40"></label><button class="btn primary">Сохранить</button><button type="button" class="btn ghost" data-action="hide-lesson">Отмена</button></form></section>' : '') +
    (rows ? '<div class="lesson-list">' + rows + '</div>' : empty('Расписание пока пустое', 'Староста сможет добавить пары в этом разделе.'));
}

function lessonWeekFor(date) {
  const [sy,sm,sd] = (state.group.studyCycleStart || today()).split('-').map(Number);
  const [y,m,d] = date.split('-').map(Number);
  const start = Date.UTC(sy,sm-1,sd);
  const target = Date.UTC(y,m-1,d);
  const weeks = Math.floor((target - start) / 604800000);
  return ((weeks % 2) + 2) % 2 + 1;
}

function renderAttendance() {
  const date = state.attendanceDate;
  const [y,m,d] = date.split('-').map(Number);
  const weekday = ((new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7)+1;
  const week = lessonWeekFor(date);
  const lessons = state.lessons.filter(item => item.weekday === weekday && item.weekNumber === week);
  const ownResponses = new Map(state.attendance.filter(item => item.userId === state.user.uid).map(item => [item.lessonId, item.response]));
  return heading('ПОСЕЩАЕМОСТЬ', 'Предварительная явка', 'Отметь, планируешь ли ты быть на паре. Это не официальная отметка посещения.') +
    '<div class="date-picker"><label>Дата<input type="date" id="attendance-date" value="' + date + '"></label><span>' + (week === 1 ? 'Первая' : 'Вторая') + ' учебная неделя</span></div>' +
    (lessons.length ? '<div class="attendance">' + lessons.map(item => {
      const responses = state.attendance.filter(response => response.lessonId === item.id);
      const attending = responses.filter(response => response.response === 'will_attend').length;
      const missing = responses.filter(response => response.response === 'will_miss').length;
      return '<article class="lesson attendance-item"><div><small>' + esc(item.startsAt) + (item.endsAt ? '–' + esc(item.endsAt) : '') + '</small><strong>' + esc(item.subject) + '</strong><p>' + esc(item.room || 'Аудитория не указана') + (state.role === 'leader' ? ' · Будут: ' + attending + ' · Не будут: ' + missing : '') + '</p></div><div class="actions"><button class="btn ' + (ownResponses.get(item.id) === 'will_attend' ? 'primary' : 'secondary') + '" data-attendance="will_attend" data-lesson="' + esc(item.id) + '">Буду</button><button class="btn ' + (ownResponses.get(item.id) === 'will_miss' ? 'primary' : 'secondary') + '" data-attendance="will_miss" data-lesson="' + esc(item.id) + '">Не буду</button></div></article>';
    }).join('') + '</div>' : empty('На эту дату пар нет', 'Выбери другую дату или проверь расписание группы.')) +
    '<p class="muted small">Староста видит предварительные ответы участников. Фактическая посещаемость хранится отдельно.</p>';
}

function renderManage() {
  const select = state.memberships.length > 1
    ? '<label class="field-label">Переключить группу<select id="group-switch">' + state.memberships.map(item => '<option value="' + esc(item.groupId) + '" ' + (item.groupId === state.group.id ? 'selected' : '') + '>' + esc(item.name) + '</option>').join('') + '</select></label>'
    : '';
  const invite = state.role === 'leader' && state.activeMembership?.inviteCode
    ? '<section class="panel invite"><div><small>КОД ПРИГЛАШЕНИЯ</small><h2>' + esc(state.activeMembership.inviteCode) + '</h2><p class="muted">Отправь этот код одногруппникам.</p></div><button class="btn secondary" data-action="copy-code">Скопировать</button></section>'
    : '';
  return heading('ПРОСТРАНСТВО ГРУППЫ', 'Управление', 'Участники и настройки учебного пространства.') +
    invite +
    '<section class="panel"><p>Твоя роль: <strong>' + (state.role === 'leader' ? 'Староста' : 'Студент') + '</strong></p>' + select +
    (state.role === 'leader' ? '<form id="cycle-form" class="form"><label>Начало первой учебной недели (понедельник)<input name="studyCycleStart" type="date" value="' + esc(state.group.studyCycleStart || '') + '" required></label><button class="btn secondary">Сохранить учебный цикл</button></form>' : '') + '</section>';
}

function bindEvents() {
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.mode) return renderAuth(button.dataset.mode);
    if (button.dataset.tab) { state.tab = button.dataset.tab; return renderWorkspace(); }
    if (button.dataset.action === 'logout') return doSignOut();
    if (button.dataset.action === 'menu') { document.querySelector('.sidebar')?.classList.toggle('open'); return; }
    if (button.dataset.action === 'show-lesson') { document.querySelector('#lesson-editor')?.classList.remove('hidden'); return; }
    if (button.dataset.action === 'hide-lesson') { document.querySelector('#lesson-editor')?.classList.add('hidden'); return; }
    if (button.dataset.action === 'copy-code') {
      try { await navigator.clipboard.writeText(state.activeMembership.inviteCode); notify('Код скопирован.', 'success'); }
      catch { notify('Код приглашения: ' + state.activeMembership.inviteCode); }
      return;
    }
    if (button.dataset.review) return reviewSuggestion(button.dataset.id, button.dataset.review === 'approve');
    if (button.dataset.attendance) return saveAttendance(button.dataset.lesson, button.dataset.attendance);
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
      try { await loadWorkspace(); renderWorkspace(); }
      catch (error) { notify(error.message, 'error'); }
    }
    if (event.target.id === 'group-switch') {
      try { await selectGroup(event.target.value); }
      catch (error) { notify(error.message, 'error'); }
    }
  });
}

async function submitAuth(form) {
  const data = new FormData(form);
  const username = normalizeUsername(data.get('username'));
  const password = String(data.get('password') || '');

  if (!validUsername(username)) {
    notify('Логин: 3–24 символа, начни с буквы или цифры. Разрешены латинские буквы, цифры, точка, дефис и подчёркивание.', 'error');
    return;
  }

  // The visible login is mapped to a deterministic internal Firebase email alias.
  const authIdentifier = authEmailForUsername(username);
  setBusy(true);
  try {
    if (data.has('full_name')) {
      const fullName = String(data.get('full_name') || '').trim();
      const patronymic = String(data.get('patronymic') || '').trim();
      const displayName = [fullName, patronymic].filter(Boolean).join(' ');
      const credential = await createUserWithEmailAndPassword(auth, authIdentifier, password);
      await updateProfile(credential.user, { displayName });
      const profileRef = doc(db, 'users', credential.user.uid);
      const existingProfile = await getDoc(profileRef);
      if (existingProfile.exists()) {
        await updateDoc(profileRef, { fullName, patronymic, username, updatedAt: serverTimestamp() });
      } else {
        await setDoc(profileRef, {
          fullName,
          patronymic,
          username,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      state.profile = { fullName, patronymic, username };
      await boot(credential.user);
    } else {
      const credential = await signInWithEmailAndPassword(auth, authIdentifier, password);
      await boot(credential.user);
    }
  } catch (error) {
    const message = error.code === 'auth/email-already-in-use' ? 'Этот логин уже занят. Выбери другой.' :
      error.code === 'auth/invalid-credential' ? 'Неверный логин или пароль.' :
      error.code === 'auth/weak-password' ? 'Пароль должен содержать не менее 8 символов.' :
      error.code === 'auth/invalid-email' ? 'Проверь логин: используй латинские буквы, цифры, точку, дефис или подчёркивание.' :
      error.message || 'Ошибка авторизации.';
    notify(message, 'error');
  } finally {
    setBusy(false);
  }
}

async function createGroup(form) {
  const name = String(new FormData(form).get('name') || '').trim();
  setBusy(true);
  try {
    const groupRef = doc(collection(db, 'groups'));
    const inviteCode = makeInviteCode();
    const groupId = groupRef.id;
    const userRef = doc(db, 'users', state.user.uid);
    const memberRef = doc(db, 'groups', groupId, 'members', state.user.uid);
    const userGroupRef = doc(db, 'users', state.user.uid, 'groups', groupId);
    const inviteRef = doc(db, 'inviteCodes', inviteCode);
    const cycleStart = mondayOf(new Date());

    const batch = writeBatch(db);
    batch.set(groupRef, {
      name,
      createdBy: state.user.uid,
      studyCycleStart: cycleStart,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    batch.set(memberRef, {
      userId: state.user.uid,
      displayName: displayFullName(state.profile),
      role: 'leader',
      joinedAt: serverTimestamp()
    });
    batch.set(userGroupRef, {
      groupId,
      name,
      role: 'leader',
      inviteCode,
      joinedAt: serverTimestamp()
    });
    batch.set(inviteRef, {
      groupId,
      groupName: name,
      createdBy: state.user.uid,
      createdAt: serverTimestamp()
    });
    await batch.commit();
    await loadMemberships();
    await selectGroup(groupId);
  } catch (error) {
    notify(error.message || 'Не удалось создать группу.', 'error');
  } finally {
    setBusy(false);
  }
}

async function joinGroup(form) {
  const code = String(new FormData(form).get('code') || '').trim().toUpperCase();
  setBusy(true);
  try {
    const inviteSnapshot = await getDoc(doc(db, 'inviteCodes', code));
    if (!inviteSnapshot.exists()) throw new Error('Код приглашения не найден.');
    const invite = inviteSnapshot.data();
    const groupId = invite.groupId;
    const memberRef = doc(db, 'groups', groupId, 'members', state.user.uid);
    const existing = await getDoc(memberRef);
    if (existing.exists()) {
      await loadMemberships();
      return selectGroup(groupId);
    }

    const batch = writeBatch(db);
    batch.set(memberRef, {
      userId: state.user.uid,
      displayName: displayFullName(state.profile),
      role: 'student',
      inviteCodeUsed: code,
      joinedAt: serverTimestamp()
    });
    batch.set(doc(db, 'users', state.user.uid, 'groups', groupId), {
      groupId,
      name: invite.groupName || 'Учебная группа',
      role: 'student',
      joinedAt: serverTimestamp()
    });
    await batch.commit();
    await loadMemberships();
    await selectGroup(groupId);
  } catch (error) {
    notify(error.message || 'Не удалось вступить в группу.', 'error');
  } finally {
    setBusy(false);
  }
}

async function submitTask(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    subject: String(values.subject || '').trim(),
    title: String(values.title || '').trim(),
    description: String(values.description || '').trim(),
    lessonDate: values.lessonDate || null,
    dueDate: values.dueDate || null
  };
  setBusy(true);
  try {
    if (state.role === 'leader') {
      await addDoc(groupCollection('tasks'), {
        ...payload,
        createdBy: state.user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sourceSuggestionId: null
      });
      notify('Задание опубликовано.', 'success');
    } else {
      await addDoc(groupCollection('taskSuggestions'), {
        ...payload,
        submittedBy: state.user.uid,
        status: 'pending',
        createdAt: serverTimestamp()
      });
      notify('Предложение отправлено старосте.', 'success');
    }
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось сохранить задание.', 'error');
  } finally {
    setBusy(false);
  }
}

async function reviewSuggestion(suggestionId, approve) {
  setBusy(true);
  try {
    const suggestionRef = groupDocument('taskSuggestions', suggestionId);
    const taskRef = doc(groupCollection('tasks'));
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(suggestionRef);
      if (!snapshot.exists()) throw new Error('Предложение не найдено.');
      const suggestion = snapshot.data();
      if (suggestion.status !== 'pending') throw new Error('Предложение уже рассмотрено.');

      if (approve) {
        transaction.set(taskRef, {
          subject: suggestion.subject || '',
          title: suggestion.title,
          description: suggestion.description || '',
          lessonDate: suggestion.lessonDate || null,
          dueDate: suggestion.dueDate || null,
          createdBy: state.user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          sourceSuggestionId: suggestionId
        });
        transaction.update(suggestionRef, {
          status: 'approved',
          reviewedBy: state.user.uid,
          reviewedAt: serverTimestamp(),
          publishedTaskId: taskRef.id
        });
      } else {
        transaction.update(suggestionRef, {
          status: 'rejected',
          reviewedBy: state.user.uid,
          reviewedAt: serverTimestamp()
        });
      }
    });
    notify(approve ? 'Задание опубликовано для группы.' : 'Предложение отклонено.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось обработать предложение.', 'error');
  } finally {
    setBusy(false);
  }
}

async function updateProgress(input) {
  const taskId = input.dataset.progress;
  const progressId = taskId + '_' + state.user.uid;
  const progressRef = groupDocument('taskProgress', progressId);
  const current = state.progress.get(taskId);
  setBusy(true);
  try {
    await setDoc(progressRef, {
      taskId,
      userId: state.user.uid,
      completed: input.checked,
      updatedAt: serverTimestamp()
    }, { merge: true });
    state.progress.set(taskId, input.checked);
    notify('Личный прогресс сохранён.', 'success');
  } catch (error) {
    input.checked = Boolean(current);
    notify(error.message || 'Не удалось сохранить отметку.', 'error');
  } finally {
    setBusy(false);
  }
}

async function submitLesson(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  setBusy(true);
  try {
    await addDoc(groupCollection('lessons'), {
      subject: String(values.subject || '').trim(),
      weekday: Number(values.weekday),
      weekNumber: Number(values.weekNumber),
      startsAt: values.startsAt,
      endsAt: values.endsAt || '',
      room: String(values.room || '').trim(),
      createdBy: state.user.uid,
      createdAt: serverTimestamp()
    });
    notify('Пара добавлена.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось добавить пару.', 'error');
  } finally {
    setBusy(false);
  }
}

async function saveAttendance(lessonId, response) {
  const responseId = lessonId + '_' + state.attendanceDate + '_' + state.user.uid;
  const responseRef = groupDocument('attendanceResponses', responseId);
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
        renderAuth('login', 'Firebase подключён, но Firestore не разрешил запрос. Проверь, что опубликованы firestore.rules.');
      } else {
        renderAuth('login', 'Не удалось загрузить данные: ' + (error.message || 'неизвестная ошибка'));
      }
    }
  });
}

start();
