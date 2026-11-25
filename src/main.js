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
  scheduleEditorSlot: null,
  selectedTaskLessonId: null,
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

  const readQuery = async (label, promise) => {
    try {
      return await promise;
    } catch (error) {
      console.error('STUDIUM Firestore query failed:', label, error);
      error.message = label + ': ' + error.message;
      throw error;
    }
  };
  const [tasks, suggestions, lessons, progress, attendance] = await Promise.all([
    readQuery('Домашние задания', getDocs(taskQuery)),
    readQuery('Предложения ДЗ', getDocs(suggestionQuery)),
    readQuery('Расписание', getDocs(lessonQuery)),
    readQuery('Личный прогресс', getDocs(progressQuery)),
    readQuery('Предварительная посещаемость', getDocs(attendanceQuery))
  ]);

  state.tasks = tasks.docs.map(item => ({ id: item.id, ...item.data() }))
    .sort((a,b) => String(a.lessonDate || a.dueDate || '').localeCompare(String(b.lessonDate || b.dueDate || '')));
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

function taskForm() {
  const weekdayNames = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const lessons = state.lessons.slice().sort((a,b) =>
    Number(a.weekNumber) - Number(b.weekNumber) ||
    Number(a.weekday) - Number(b.weekday) ||
    String(a.startsAt).localeCompare(String(b.startsAt))
  );
  if (!lessons.length) {
    return '<section class="panel compose"><div><p class="eyebrow">НОВОЕ ЗАДАНИЕ</p><h2>' +
      (state.role === 'leader' ? 'Опубликовать ДЗ' : 'Предложить ДЗ') +
      '</h2><p class="muted">Сначала добавь пары в разделе «Расписание», затем привязывай к ним домашние задания.</p></div>' +
      '<p class="task-no-lessons">В расписании пока нет пар. <button class="text-btn" type="button" data-tab="schedule">Открыть расписание →</button></p></section>';
  }

  let selected = lessons.find(item => item.id === state.selectedTaskLessonId) || lessons[0];
  state.selectedTaskLessonId = selected.id;
  const selectedDate = nextLessonDate(selected);
  const weekNames = {1:'Первая',2:'Вторая'};
  const weeks = [1,2].map(week => {
    const days = [1,2,3,4,5,6].map(day => {
      const dayLessons = lessons.filter(item =>
        Number(item.weekNumber) === week && Number(item.weekday) === day
      );
      const cards = dayLessons.length
        ? dayLessons.map(lesson => {
            const lessonDate = nextLessonDate(lesson);
            const isSelected = lesson.id === selected.id;
            return '<button type="button" class="task-lesson-option' + (isSelected ? ' selected' : '') +
              '" data-action="select-task-lesson" data-id="' + esc(lesson.id) + '" aria-pressed="' + isSelected + '">' +
              '<span class="task-lesson-time">' + esc(lesson.startsAt || '') +
              (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') + '</span>' +
              '<strong>' + esc(lesson.subject) + '</strong>' +
              '<small>' + esc(dateText(lessonDate)) + '</small>' +
              (lesson.room ? '<small class="task-lesson-room">' + esc(lesson.room) + '</small>' : '') +
              (isSelected ? '<span class="task-lesson-selected">Выбрано</span>' : '') +
              '</button>';
          }).join('')
        : '<div class="task-lesson-day-empty">Нет пар</div>';
      return '<article class="task-schedule-day"><header>' + weekdayNames[day] + '</header><div class="task-schedule-day-lessons">' + cards + '</div></article>';
    }).join('');
    return '<section class="task-schedule-week"><p class="eyebrow">' + weekNames[week] + ' УЧЕБНАЯ НЕДЕЛЯ</p><div class="task-schedule-grid">' + days + '</div></section>';
  }).join('');

  const taskPickerStyles = `<style>
.task-compose{display:block;margin-bottom:23px}
.task-compose-intro{margin-bottom:18px}
.task-compose-intro h2{font:700 22px Manrope,sans-serif;margin:3px 0 7px}
.task-compose-intro p.muted{max-width:720px}
.task-schedule-picker{border:1px solid var(--line);border-radius:14px;background:#fbfbfa;padding:14px;margin-bottom:17px}
.task-schedule-picker-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.task-schedule-picker-head strong{font:700 15px Manrope,sans-serif}
.task-schedule-picker-head span{font-size:10px;color:var(--muted)}
.task-schedule-week+.task-schedule-week{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.task-schedule-week>.eyebrow{margin-bottom:8px}
.task-schedule-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;align-items:start}
.task-schedule-day{min-width:0;background:#fff;border:1px solid var(--line);border-radius:10px;padding:9px}
.task-schedule-day>header{font-size:11px;font-weight:700;margin-bottom:7px}
.task-schedule-day-lessons{display:flex;flex-direction:column;gap:6px}
.task-lesson-day-empty{border:1px dashed #e3e1e9;border-radius:7px;padding:9px;color:#b1afb9;font-size:10px}
.task-lesson-option{width:100%;min-width:0;text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:4px;border:1px solid #e5e3ed;border-left:3px solid #8c7cf0;border-radius:8px;background:#f7f6fc;color:var(--ink);padding:8px 9px;transition:border-color .15s,background .15s,box-shadow .15s}
.task-lesson-option:hover{border-color:#988bf1;background:#f1efff;box-shadow:0 2px 8px #7665ee12}
.task-lesson-option.selected{border:1.5px solid #6f5dea;border-left:4px solid #6f5dea;background:#eeeaff;box-shadow:0 3px 12px #7665ee24}
.task-lesson-time{font-size:9px;color:#77749a;font-weight:600}
.task-lesson-option strong{font-size:11px;line-height:1.35;overflow-wrap:anywhere}
.task-lesson-option>small{font-size:9px;color:#888}
.task-lesson-option .task-lesson-room{color:#666}
.task-lesson-selected{align-self:flex-end;font-size:8px;font-weight:800;color:#fff;background:#6657df;border-radius:999px;padding:3px 7px}
.task-selected-lesson{border:1px solid #dcd7ff;background:#f8f7ff;border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:12px}
.task-selected-lesson-head{display:flex;align-items:center;justify-content:space-between;color:#6b5bd5}
.task-selected-lesson-head span{font-size:9px;letter-spacing:.16em;font-weight:800}
.task-selected-lesson-head b{width:22px;height:22px;display:grid;place-items:center;background:#6b5bd5;color:#fff;border-radius:50%;font-size:12px}
.task-selected-lesson-details{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.task-selected-lesson-details>div{min-width:0;display:flex;flex-direction:column;gap:4px}
.task-selected-lesson-details small{font-size:9px;color:#888}
.task-selected-lesson-details strong{font-size:11px;overflow-wrap:anywhere}
@media(max-width:1100px){.task-schedule-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:680px){.task-schedule-grid{grid-template-columns:1fr}.task-selected-lesson-details{grid-template-columns:repeat(2,minmax(0,1fr))}.task-schedule-picker{padding:10px}.task-schedule-picker-head{align-items:flex-start;flex-direction:column;gap:4px}}
</style>`;
  return taskPickerStyles + '<section class="panel task-compose"><div class="task-compose-intro"><p class="eyebrow">НОВОЕ ЗАДАНИЕ</p><h2>' +
    (state.role === 'leader' ? 'Опубликовать ДЗ' : 'Предложить ДЗ') +
    '</h2><p class="muted">' +
    (state.role === 'leader' ? 'Нажми на нужную пару в расписании — она выделится, а её дата и предмет подставятся автоматически.' : 'Выбери пару в расписании, чтобы привязать к ней своё предложение.') +
    '</p></div>' +
    '<form id="task-form" class="form task-form">' +
    '<div class="task-schedule-picker"><div class="task-schedule-picker-head"><strong>Выбери пару</strong><span>Нажми на карточку занятия</span></div>' + weeks + '</div>' +
    '<input type="hidden" name="lessonId" value="' + esc(selected.id) + '">' +
    '<div class="task-selected-lesson">' +
      '<div class="task-selected-lesson-head"><span>ВЫБРАННАЯ ПАРА</span><b>✓</b></div>' +
      '<div class="task-selected-lesson-details">' +
        '<div><small>Предмет</small><strong data-selected-subject>' + esc(selected.subject) + '</strong></div>' +
        '<div><small>День недели</small><strong data-selected-weekday>' + esc(weekdayNames[selected.weekday] || '') + '</strong></div>' +
        '<div><small>Дата пары</small><strong data-selected-date>' + esc(dateText(selectedDate)) + '</strong></div>' +
        '<div><small>Время</small><strong data-selected-time>' + esc(selected.startsAt || '') + (selected.endsAt ? '–' + esc(selected.endsAt) : '') + '</strong></div>' +
      '</div>' +
      '<input type="hidden" name="lessonDate" value="' + selectedDate + '">' +
      '<input type="hidden" name="subject" value="' + esc(selected.subject) + '">' +
      '<input type="hidden" name="weekday" value="' + Number(selected.weekday) + '">' +
      '<input type="hidden" name="weekNumber" value="' + Number(selected.weekNumber) + '">' +
      '<input type="hidden" name="lessonTime" value="' + esc(selected.startsAt || '') + '">' +
    '</div>' +
    '<label>Название задания<input name="title" required maxlength="180" placeholder="Что нужно сделать?"></label>' +
    '<label>Описание<textarea name="description" rows="3" placeholder="Дополнительные требования, страницы, вопросы…"></textarea></label>' +
    '<button class="btn primary">' + (state.role === 'leader' ? 'Опубликовать' : 'Отправить старосте') + '</button>' +
    '</form></section>';
}

function renderTasks() {
  return heading('УЧЕБНЫЙ ПРОЦЕСС', 'Домашние задания', 'Общий список группы и твой персональный прогресс.') + taskForm() + taskCards(state.tasks);
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
  return '<article class="schedule-lesson" style="grid-row:span ' + span + '">' +
    '<div class="schedule-times">' + times + '</div>' +
    '<strong>' + esc(lesson.subject) + '</strong>' +
    (lesson.room ? '<small class="schedule-room">' + esc(lesson.room) + '</small>' : '') +
    (lesson.description ? '<p class="schedule-description">' + esc(lesson.description) + '</p>' : '') +
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
    ? 'Наведись на свободную ячейку и нажми «＋ Добавить пару», чтобы заполнить её прямо в расписании.'
    : 'Расписание занятий группы на первой и второй учебной неделе.';
  return heading('РАСПИСАНИЕ', 'Расписание группы', hint) + weekSummary + weeks;
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
    if (button.dataset.action === 'select-task-lesson') {
      const lesson = state.lessons.find(item => item.id === button.dataset.id);
      const form = root.querySelector('#task-form');
      if (!lesson || !form) return;
      state.selectedTaskLessonId = lesson.id;
      const weekdayNames = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
      const lessonDate = nextLessonDate(lesson);
      form.elements.lessonId.value = lesson.id;
      form.elements.lessonDate.value = lessonDate;
      form.elements.subject.value = lesson.subject || '';
      form.elements.weekday.value = Number(lesson.weekday);
      form.elements.weekNumber.value = Number(lesson.weekNumber);
      form.elements.lessonTime.value = lesson.startsAt || '';
      root.querySelector('[data-selected-subject]').textContent = lesson.subject || '';
      root.querySelector('[data-selected-weekday]').textContent = weekdayNames[lesson.weekday] || '';
      root.querySelector('[data-selected-date]').textContent = dateText(lessonDate);
      root.querySelector('[data-selected-time]').textContent = (lesson.startsAt || '') + (lesson.endsAt ? '–' + lesson.endsAt : '');
      root.querySelectorAll('.task-lesson-option').forEach(option => {
        const selectedOption = option.dataset.id === lesson.id;
        option.classList.toggle('selected', selectedOption);
        option.setAttribute('aria-pressed', String(selectedOption));
        const selectedLabel = option.querySelector('.task-lesson-selected');
        if (selectedOption && !selectedLabel) {
          const label = document.createElement('span');
          label.className = 'task-lesson-selected';
          label.textContent = 'Выбрано';
          option.append(label);
        } else if (!selectedOption && selectedLabel) {
          selectedLabel.remove();
        }
      });
      return;
    }
    if (button.dataset.action === 'delete-lesson') return deleteLesson(button.dataset.id);
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
      const patronymic = '';
      const displayName = fullName;
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
  const lesson = state.lessons.find(item => item.id === values.lessonId);
  if (!lesson) {
    notify('Выбери пару из расписания.', 'error');
    return;
  }
  const weekdayNames = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const lessonDate = nextLessonDate(lesson);
  const payload = {
    subject: lesson.subject,
    lessonId: lesson.id,
    weekday: Number(lesson.weekday),
    weekNumber: Number(lesson.weekNumber),
    lessonTime: lesson.startsAt || '',
    lessonDate,
    title: String(values.title || '').trim(),
    description: String(values.description || '').trim()
  };
  if (!payload.title) {
    notify('Укажи название домашнего задания.', 'error');
    return;
  }
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
          lessonId: suggestion.lessonId || null,
          weekday: suggestion.weekday || null,
          weekNumber: suggestion.weekNumber || null,
          lessonTime: suggestion.lessonTime || '',
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
  const startIndex = Number(values.startPeriod);
  const periodCount = Number(values.periodCount);
  const weekNumber = Number(values.weekNumber);
  const weekday = Number(values.weekday);
  if (!Number.isInteger(startIndex) || !Number.isInteger(periodCount) ||
      startIndex < 0 || periodCount < 1 || periodCount > 3 ||
      startIndex + periodCount > schedulePeriods.length ||
      ![1,2].includes(weekNumber) || weekday < 1 || weekday > 6) {
    notify('Проверь выбранное время и продолжительность пары.', 'error');
    return;
  }
  const endIndex = startIndex + periodCount;
  const overlaps = state.lessons.some(item => {
    if (Number(item.weekNumber) !== weekNumber || Number(item.weekday) !== weekday) return false;
    const existingStart = lessonStartIndex(item);
    if (existingStart < 0) return false;
    const existingEnd = existingStart + lessonSpan(item, existingStart);
    return startIndex < existingEnd && existingStart < endIndex;
  });
  if (overlaps) {
    notify('Это время пересекается с уже добавленной парой.', 'error');
    return;
  }
  const startPeriod = schedulePeriods[startIndex];
  const endPeriod = schedulePeriods[endIndex - 1];
  setBusy(true);
  try {
    await addDoc(groupCollection('lessons'), {
      subject: String(values.subject || '').trim(),
      weekday,
      weekNumber,
      startsAt: startPeriod.start,
      endsAt: endPeriod.end,
      periodCount,
      room: String(values.room || '').trim(),
      description: String(values.description || '').trim(),
      createdBy: state.user.uid,
      createdAt: serverTimestamp()
    });
    state.scheduleEditorSlot = null;
    notify('Пара добавлена в расписание.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось добавить пару.', 'error');
  } finally {
    setBusy(false);
  }
}

async function deleteLesson(lessonId) {
  if (state.role !== 'leader') {
    notify('Удалять пары может только староста.', 'error');
    return;
  }
  const lesson = state.lessons.find(item => item.id === lessonId);
  if (!lesson) {
    notify('Пара уже отсутствует в расписании.', 'error');
    return;
  }
  const label = [lesson.subject, lesson.startsAt].filter(Boolean).join(' · ');
  const confirmed = window.confirm(
    'Удалить пару «' + label + '»?\n\nСвязанные предварительные ответы и официальные отметки посещаемости также будут удалены.'
  );
  if (!confirmed) return;

  setBusy(true);
  try {
    const [responses, records] = await Promise.all([
      getDocs(query(collection(db, 'groups', state.group.id, 'attendanceResponses'), where('lessonId', '==', lessonId))),
      getDocs(query(collection(db, 'groups', state.group.id, 'attendanceRecords'), where('lessonId', '==', lessonId)))
    ]);
    const refs = [
      ...responses.docs.map(item => item.ref),
      ...records.docs.map(item => item.ref),
      groupDocument('lessons', lessonId)
    ];

    // Keep each Firestore batch comfortably below the 500-write limit.
    for (let offset = 0; offset < refs.length; offset += 450) {
      const batch = writeBatch(db);
      refs.slice(offset, offset + 450).forEach(ref => batch.delete(ref));
      await batch.commit();
    }

    notify('Пара и связанные отметки удалены.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    console.error('STUDIUM delete lesson failed:', error);
    notify(error.message || 'Не удалось удалить пару. Проверь правила Firestore.', 'error');
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
        renderAuth('login', 'Вход выполнен, но Firestore отклонил доступ. ' + (error.message || 'Проверь опубликованные правила Firestore.'));
      } else {
        renderAuth('login', 'Не удалось загрузить данные: ' + (error.message || 'неизвестная ошибка'));
      }
    }
  });
}

start();
