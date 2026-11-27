import './style.css';
import { downloadAttendanceReport } from './attendance-report.js';
import { supabase, supabaseConfigured } from './supabase.js';
import { signUpWithUsername, signInWithUsername, signOutFromSupabase } from './supabase-auth.js';
import {
  db, addDoc, collection, doc, deleteDoc, getDoc, getDocs, onSnapshot,
  orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch
} from './supabase-data.js';

const root = document.querySelector('#app');
const normalizeUsername = value => String(value ?? '').trim().toLowerCase();
const validUsername = value => /^[a-z0-9][a-z0-9._-]{2,23}$/.test(value);

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
  theme: localStorage.getItem('studium-theme') || 'mono',
  tasks: [],
  suggestions: [],
  lessons: [],
  progress: new Map(),
  attendance: [],
  attendanceRecords: [],
  materials: [],
  groupMembers: [],
  selectedAttendanceLessonId: null,
  selectedAttendancePartKey: null,
  attendanceDate: today(),
  scheduleEditorSlot: null,
  selectedScheduleLessonId: null,
  busy: false,
  authMode: 'login',
  liveUnsubscribers: [],
  liveSubscriptionToken: 0,
  deadlineMonth: today().slice(0, 7),
  selectedDeadlineDate: today()
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
  root.setAttribute('aria-busy', flag ? 'true' : 'false');
  root.classList.toggle('app-busy', flag);
}

function domKey(node) {
  if (node.nodeType !== 1) return null;
  if (node.id) return 'id:' + node.id;
  const explicit = node.getAttribute('data-key');
  if (explicit) return 'key:' + explicit;
  for (const attribute of ['data-progress', 'data-attendance-lesson', 'data-schedule-lesson']) {
    if (node.hasAttribute(attribute)) return attribute + ':' + node.getAttribute(attribute);
  }
  if (node.dataset.action && node.dataset.id) {
    return 'action:' + node.dataset.action + ':' + node.dataset.id;
  }
  if (node.dataset.student && node.dataset.lesson) {
    return 'student:' + node.dataset.student + ':' + node.dataset.lesson;
  }
  return null;
}

function compatibleNodes(current, fresh) {
  if (current.nodeType !== fresh.nodeType) return false;
  if (current.nodeType === 1 && current.tagName !== fresh.tagName) return false;
  return true;
}

function syncFormControl(current, fresh) {
  if (current.nodeType !== 1) return;
  const tag = current.tagName;
  const focused = current === document.activeElement;

  if (tag === 'INPUT') {
    const type = (current.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      current.checked = fresh.checked;
      current.indeterminate = fresh.indeterminate;
    } else if (type === 'date' || type === 'time' || type === 'month' || type === 'week' || type === 'hidden') {
      current.value = fresh.value;
    } else if (!focused) {
      const wasEdited = current.value !== current.defaultValue;
      const nextValue = fresh.value;
      current.defaultValue = fresh.defaultValue;
      if (!wasEdited) current.value = nextValue;
    }
  } else if (tag === 'TEXTAREA') {
    if (!focused) {
      const wasEdited = current.value !== current.defaultValue;
      const nextValue = fresh.value;
      current.defaultValue = fresh.defaultValue;
      if (!wasEdited) current.value = nextValue;
    }
  } else if (tag === 'SELECT' && !focused) {
    const nextValue = fresh.value;
    if (Array.from(current.options).some(option => option.value === nextValue)) {
      current.value = nextValue;
    }
  }
}

function morphNode(current, fresh) {
  if (!compatibleNodes(current, fresh)) return fresh.cloneNode(true);

  if (current.nodeType === 3 || current.nodeType === 8) {
    if (current.nodeValue !== fresh.nodeValue) current.nodeValue = fresh.nodeValue;
    return current;
  }

  const nextAttributes = new Map(Array.from(fresh.attributes, attribute => [attribute.name, attribute.value]));
  Array.from(current.attributes).forEach(attribute => {
    if (!nextAttributes.has(attribute.name)) current.removeAttribute(attribute.name);
  });
  nextAttributes.forEach((value, name) => {
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  });

  morphChildren(current, fresh);
  syncFormControl(current, fresh);
  return current;
}

function morphChildren(currentParent, freshParent) {
  const oldChildren = Array.from(currentParent.childNodes);
  const newChildren = Array.from(freshParent.childNodes);
  const keyed = new Map();
  oldChildren.forEach(node => {
    const key = domKey(node);
    if (key) keyed.set(key, node);
  });
  const used = new Set();
  let searchFrom = 0;

  newChildren.forEach((freshNode, index) => {
    const key = domKey(freshNode);
    let candidate = key ? keyed.get(key) : null;

    if (!candidate && !key) {
      const preferred = oldChildren[index];
      if (preferred && !used.has(preferred) && !domKey(preferred) && compatibleNodes(preferred, freshNode)) {
        candidate = preferred;
      } else {
        for (let cursor = searchFrom; cursor < oldChildren.length; cursor++) {
          const option = oldChildren[cursor];
          if (!used.has(option) && !domKey(option) && compatibleNodes(option, freshNode)) {
            candidate = option;
            searchFrom = cursor + 1;
            break;
          }
        }
      }
    }

    let nextNode;
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      nextNode = morphNode(candidate, freshNode);
      if (nextNode !== candidate && candidate.parentNode === currentParent) {
        currentParent.replaceChild(nextNode, candidate);
      }
    } else {
      nextNode = freshNode.cloneNode(true);
    }

    const reference = currentParent.childNodes[index] || null;
    if (reference !== nextNode) currentParent.insertBefore(nextNode, reference);
  });

  oldChildren.forEach(node => {
    if (!used.has(node) && node.parentNode === currentParent) currentParent.removeChild(node);
  });
}

function frame(html) {
  const template = document.createElement('template');
  template.innerHTML = html + '<div id="toast" role="status" aria-live="polite"></div>';
  morphChildren(root, template.content);
}

function renderSetup() {
  frame('<main class="setup"><div class="monogram">S</div><p class="eyebrow">НАСТРОЙКА SUPABASE</p><h1>STUDIUM</h1><p class="muted">Подключи Supabase, чтобы запустить учебное пространство.</p><article class="panel"><h2>Параметры проекта</h2><ol><li>Создай проект в <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Supabase Dashboard</a>.</li><li>Добавь <code>VITE_SUPABASE_URL</code> и <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> в переменные окружения.</li><li>Примени SQL-миграции из каталога <code>supabase/migrations</code>.</li><li>В настройках Authentication отключи подтверждение email, так как вход выполняется по логину.</li></ol></article></main>');
}

function renderAuth(mode = 'login', message = '') {
  const signup = mode === 'signup';
  state.authMode = mode;
  frame('<main class="auth"><section class="auth-intro"><div class="monogram">S</div><p class="eyebrow">YOUR ACADEMIC SPACE</p><h1>STUDIUM</h1><p>Всё важное для учёбы — в одном пространстве.</p><div class="ornament">— ✦ —</div></section><section class="panel auth-panel"><div class="switch"><button type="button" data-mode="login" class="' + (!signup ? 'active' : '') + '">Войти</button><button type="button" data-mode="signup" class="' + (signup ? 'active' : '') + '">Регистрация</button></div><h2>' + (signup ? 'Создать аккаунт' : 'С возвращением') + '</h2><p class="muted">' + (message ? esc(message) : (signup ? 'Создай аккаунт, чтобы присоединиться к своей группе.' : 'Войди в своё учебное пространство.')) + '</p><form id="auth-form" class="form">' + (signup ? '<label>ФИО<input name="full_name" minlength="2" maxlength="80" autocomplete="name" required placeholder="Жабов Жаб Жабович"></label>' : '') + '<label>Логин<input name="username" type="text" minlength="3" maxlength="24" autocapitalize="none" spellcheck="false" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,23}" required placeholder=""><small class="muted">3–24 символа: латинские буквы, цифры, точка, дефис или подчёркивание.</small></label><label>Пароль<input name="password" type="password" minlength="8" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" required placeholder="Не менее 8 символов"></label><button class="btn primary" type="submit">' + (signup ? 'Создать аккаунт' : 'Войти') + '</button></form><p class="foot muted">STUDIUM · учебное пространство твоей группы</p></section></main>');
}

async function ensureProfile(user) {
  const { data, error } = await supabase.from('profiles')
    .select('id, username, full_name, patronymic').eq('id', user.id).maybeSingle();
  if (error) throw error;
  let profile = data;
  if (!profile) {
    const username = normalizeUsername(user.user_metadata?.username || (user.email || '').split('@')[0]);
    const fullName = String(user.user_metadata?.full_name || username || 'Студент');
    const { data: created, error: insertError } = await supabase.from('profiles').insert({
      id: user.id, username, full_name: fullName, patronymic: ''
    }).select('id, username, full_name, patronymic').single();
    if (insertError) throw insertError;
    profile = created;
  }
  state.profile = {
    fullName: profile.full_name || '',
    patronymic: profile.patronymic || '',
    username: profile.username || ''
  };
}

async function loadMemberships() {
  const { data, error } = await supabase.from('group_members')
    .select('group_id, role, display_name, joined_at, study_groups(id, name)')
    .eq('user_id', state.user.id);
  if (error) throw error;
  const { data: inviteRows, error: inviteError } = await supabase.rpc('get_my_group_invite_codes');
  if (inviteError) throw inviteError;
  const inviteByGroup = new Map((inviteRows || []).map(item => [item.group_id, item.code]));
  state.memberships = (data || []).map(item => ({
    id: item.group_id, groupId: item.group_id, role: item.role,
    name: item.study_groups?.name || 'Учебная группа',
    inviteCode: item.role === 'leader' ? (inviteByGroup.get(item.group_id) || null) : null,
    joinedAt: item.joined_at
  }));
}

async function boot(user = null) {
  state.user = user ? { ...user, uid: user.id } : null;
  if (!state.user) {
    stopLiveHomeworkUpdates();
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

function stopLiveHomeworkUpdates() {
  state.liveSubscriptionToken += 1;
  state.liveUnsubscribers.forEach(unsubscribe => {
    try { unsubscribe(); } catch (error) { console.warn('STUDIUM unsubscribe:', error); }
  });
  state.liveUnsubscribers = [];
}

function subscribeToLiveHomework() {
  stopLiveHomeworkUpdates();
  if (!state.user || !state.group?.id) return;

  const groupId = state.group.id;
  const userId = state.user.uid;
  const role = state.role;
  const token = state.liveSubscriptionToken;
  const attendanceDate = state.attendanceDate;
  const isCurrentSubscription = () =>
    token === state.liveSubscriptionToken &&
    state.group?.id === groupId &&
    state.user?.uid === userId;

  const tasksQuery = query(
    collection(db, 'groups', groupId, 'tasks'),
    orderBy('lessonDate', 'asc')
  );
  const suggestionsRef = collection(db, 'groups', groupId, 'taskSuggestions');
  const suggestionsQuery = role === 'leader'
    ? query(suggestionsRef, where('status', '==', 'pending'), orderBy('createdAt', 'desc'))
    : query(suggestionsRef, where('submittedBy', '==', userId), orderBy('createdAt', 'desc'));
  const attendanceConstraints = [where('lessonDate', '==', attendanceDate)];
  if (role !== 'leader') attendanceConstraints.push(where('userId', '==', userId));
  const attendanceQuery = query(
    collection(db, 'groups', groupId, 'attendanceResponses'),
    ...attendanceConstraints
  );

  const handleListenerError = (label, error) => {
    if (!isCurrentSubscription()) return;
    console.error('STUDIUM live update failed:', label, error);
    notify('Не удалось обновить ' + label + '. Проверь подключение к интернету.', 'error');
  };

  const stopTasks = onSnapshot(tasksQuery, snapshot => {
    if (!isCurrentSubscription()) return;
    state.tasks = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((a,b) => String(a.lessonDate || a.dueDate || '').localeCompare(String(b.lessonDate || b.dueDate || '')));
    renderWorkspace();
  }, error => handleListenerError('домашние задания', error));

  const stopSuggestions = onSnapshot(suggestionsQuery, snapshot => {
    if (!isCurrentSubscription()) return;
    state.suggestions = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderWorkspace();
  }, error => handleListenerError('предложения ДЗ', error));

  // Attendance responses must refresh on BOTH clients: students see their
  // selected state and the leader sees each student's response without reload.
  const stopAttendance = onSnapshot(attendanceQuery, snapshot => {
    if (!isCurrentSubscription() || state.attendanceDate !== attendanceDate) return;
    state.attendance = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    if (state.tab === 'attendance') renderWorkspace();
  }, error => handleListenerError('ответы посещаемости', error));

  state.liveUnsubscribers = [stopTasks, stopSuggestions, stopAttendance];
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
  stopLiveHomeworkUpdates();
  state.group = { id: groupSnapshot.id, ...groupSnapshot.data() };
  state.activeMembership = membership;
  state.role = membership.role;
  localStorage.setItem('studium-group', groupId);
  await loadWorkspace();
  renderWorkspace();
  subscribeToLiveHomework();
}

async function loadWorkspace() {
  const gid = state.group.id;
  const tasksRef = collection(db, 'groups', gid, 'tasks');
  const lessonsRef = collection(db, 'groups', gid, 'lessons');
  const suggestionsRef = collection(db, 'groups', gid, 'taskSuggestions');
  const progressRef = collection(db, 'groups', gid, 'taskProgress');
  const attendanceRef = collection(db, 'groups', gid, 'attendanceResponses');
  const materialsRef = collection(db, 'groups', gid, 'materials');

  const taskQuery = query(tasksRef, orderBy('lessonDate', 'asc'));
  const lessonQuery = query(lessonsRef, orderBy('weekday', 'asc'), orderBy('weekNumber', 'asc'), orderBy('startsAt', 'asc'));
  const suggestionQuery = state.role === 'leader'
    ? query(suggestionsRef, where('status', '==', 'pending'), orderBy('createdAt', 'desc'))
    : query(suggestionsRef, where('submittedBy', '==', state.user.uid), orderBy('createdAt', 'desc'));
  const progressQuery = query(progressRef, where('userId', '==', state.user.uid));
  const attendanceConstraints = [where('lessonDate', '==', state.attendanceDate)];
  if (state.role !== 'leader') attendanceConstraints.push(where('userId', '==', state.user.uid));
  const attendanceQuery = query(attendanceRef, ...attendanceConstraints);
  const materialsQuery = query(materialsRef, orderBy('createdAt', 'desc'));

  const groupMembersQuery = getDocs(collection(db, 'groups', gid, 'members'));
  const officialAttendanceQuery = state.role === 'leader'
    ? getDocs(query(collection(db, 'groups', gid, 'attendanceRecords'), where('lessonDate', '==', state.attendanceDate)))
    : Promise.resolve({ docs: [] });

  const readQuery = async (label, promise) => {
    try {
      return await promise;
    } catch (error) {
      console.error('STUDIUM Supabase query failed:', label, error);
      error.message = label + ': ' + error.message;
      throw error;
    }
  };
  const [tasks, suggestions, lessons, progress, attendance, members, attendanceRecords, materials] = await Promise.all([
    readQuery('Домашние задания', getDocs(taskQuery)),
    readQuery('Предложения ДЗ', getDocs(suggestionQuery)),
    readQuery('Расписание', getDocs(lessonQuery)),
    readQuery('Личный прогресс', getDocs(progressQuery)),
    readQuery('Предварительная посещаемость', getDocs(attendanceQuery)),
    readQuery('Список участников группы', groupMembersQuery),
    readQuery('Официальная посещаемость', officialAttendanceQuery),
    readQuery('Материалы группы', getDocs(materialsQuery))
  ]);

  state.tasks = tasks.docs.map(item => ({ id: item.id, ...item.data() }))
    .sort((a,b) => String(a.lessonDate || a.dueDate || '').localeCompare(String(b.lessonDate || b.dueDate || '')));
  state.suggestions = suggestions.docs.map(item => ({ id: item.id, ...item.data() }));
  state.lessons = lessons.docs.map(item => ({ id: item.id, ...item.data() }));
  state.progress = new Map(progress.docs.map(item => [item.data().taskId, item.data().completed === true]));
  state.attendance = attendance.docs.map(item => ({ id: item.id, ...item.data() }));
  state.groupMembers = members.docs.map(item => ({ id: item.id, ...item.data() }));
  state.attendanceRecords = attendanceRecords.docs.map(item => ({ id: item.id, ...item.data() }));
  state.materials = materials.docs.map(item => ({ id: item.id, ...item.data() }));
}

function sidebarIcon(name) {
  const paths = {
    overview: '<path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/>',
    deadlines: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9 15 2 2 4-4"/>',
    schedule: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h3M14 14h2M8 17h3"/>',
    moderation: '<path d="M9 12l2 2 4-4"/><path d="M12 3 4 6v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z"/>',
    attendance: '<path d="M4 19V5M4 19h16"/><path d="M8 15v-4M12 15V7M16 15V9"/>',
    library: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 6h16M8 10h8M8 14h8"/>',
    manage: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2z"/>'
  };
  return '<svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
}

function navButton(tab, icon, title) {
  return '<button type="button" class="' + (state.tab === tab ? 'active' : '') + '" data-tab="' + tab + '">' + sidebarIcon(icon) + '<span class="nav-label">' + title + '</span></button>';
}

function renderWorkspace() {
  const leader = state.role === 'leader';
  const name = displayFullName(state.profile);
  const mainTabs = [
    navButton('overview', 'overview', 'Обзор'),
    navButton('deadlines', 'deadlines', 'Дедлайны'),
    navButton('schedule', 'schedule', 'Расписание и ДЗ')
  ].join('');
  const groupTabs = [
    ...(leader ? [navButton('moderation', 'moderation', 'Модерация <b>' + state.suggestions.filter(item => item.status === 'pending').length + '</b>')] : []),
    navButton('attendance', 'attendance', 'Посещаемость'),
    navButton('library', 'library', 'Материалы'),
    navButton('manage', 'manage', 'Группа')
  ].join('');
  const settingsTab = navButton('appearance', 'manage', 'Оформление');

  frame('<div class="layout"><aside class="sidebar"><a class="wordmark" href="#">STUDIUM</a><div class="group-box"><div class="group-box-heading"><small>ТВОЯ ГРУППА</small></div><strong>' + esc(state.group.name) + '</strong><div class="group-box-meta"><span>' + (leader ? 'Староста' : 'Студент') + '</span><span>' + state.groupMembers.length + ' участн.</span></div></div><nav><div class="nav-section"><small>ОСНОВНОЕ</small>' + mainTabs + '</div><div class="nav-section"><small>УПРАВЛЕНИЕ ГРУППОЙ</small>' + groupTabs + '</div><div class="nav-section"><small>НАСТРОЙКИ</small>' + settingsTab + '</div></nav><div class="side-user"><button type="button" class="side-user-profile" data-tab="profile"><span class="avatar">' + esc(name.slice(0,1).toUpperCase()) + '</span><span class="side-user-copy"><strong>' + esc(name) + '</strong><small>' + esc(state.profile?.username ? '@' + state.profile.username : '') + '</small><em>Мой профиль →</em></span></button><button class="btn ghost" data-action="logout">Выйти</button></div></aside><main class="main"><header class="mobile-head"><button class="btn ghost" data-action="menu">☰</button><a class="wordmark" href="#">STUDIUM</a><span class="role">' + (leader ? 'Староста' : 'Студент') + '</span></header><div class="content">' + renderCurrentTab() + '</div></main></div>');
}

function heading(eyebrow, title, subtitle, action = '') {
  return '<div class="heading"><div><p class="eyebrow">' + eyebrow + '</p><h1>' + title + '</h1><p class="muted">' + subtitle + '</p></div>' + action + '</div>';
}

function empty(title, text) {
  return '<div class="empty"><div>✳</div><h3>' + title + '</h3><p>' + text + '</p></div>';
}


function materialDateLabel(value) {
  const date = value?.toDate ? value.toDate() : (value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Дата не указана';
}

function safeMaterialUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderMaterialItem(item) {
  const isFile = item.kind === 'file' || Boolean(item.storagePath);
  const safeUrl = safeMaterialUrl(item.externalUrl);
  const detail = isFile
    ? [item.fileName || 'Файл', item.size ? (item.size / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ' : 'Файл'].join(' · ')
    : (item.externalUrl || 'Внешняя ссылка');
  const action = isFile
    ? '<button type="button" class="btn ghost material-open" data-action="download-material" data-id="' + esc(item.id) + '">Скачать</button>'
    : (safeUrl
      ? '<a class="btn ghost material-open" href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">Открыть ссылку ↗</a>'
      : '<span class="material-invalid-link">Некорректная ссылка</span>');
  return '<article class="material-row"><span class="material-icon">' + (isFile ? '↧' : '↗') + '</span>' +
    '<div class="material-copy"><strong>' + esc(item.title) + '</strong>' +
    '<small>' + esc(detail) + ' · ' + materialDateLabel(item.createdAt) + '</small>' +
    (item.description ? '<p>' + esc(item.description) + '</p>' : '') + '</div>' +
    '<div class="material-actions">' + action +
    (state.role === 'leader' ? '<button type="button" class="material-delete" data-action="delete-material" data-id="' + esc(item.id) + '" aria-label="Удалить материал" title="Удалить">×</button>' : '') +
    '</div></article>';
}

function renderLibrary() {
  const canManage = state.role === 'leader';
  const uploadPanel = canManage
    ? '<div class="material-create-grid">' +
      '<form id="material-upload-form" class="panel material-form">' +
        '<p class="eyebrow">ЗАГРУЗКА ФАЙЛА</p><h3>Прикрепить файл</h3>' +
        '<label>Название<input name="title" maxlength="180" required placeholder="Например, Методические указания"></label>' +
        '<label>Файл<input name="file" type="file" required accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.rtf,.jpg,.jpeg,.png,.webp,.zip"></label>' +
        '<small class="muted">PDF, Word, PowerPoint, Excel, изображения и ZIP. До 20 МБ.</small>' +
        '<label>Описание <span class="muted">(необязательно)</span><textarea name="description" rows="2" maxlength="1000" placeholder="Краткое описание материала"></textarea></label>' +
        '<button class="btn primary" type="submit">Загрузить файл</button>' +
      '</form>' +
      '<form id="material-link-form" class="panel material-form">' +
        '<p class="eyebrow">ВНЕШНИЙ РЕСУРС</p><h3>Добавить ссылку</h3>' +
        '<label>Название<input name="title" maxlength="180" required placeholder="Например, Учебник по биологии"></label>' +
        '<label>Ссылка<input name="url" type="url" maxlength="2048" required placeholder="https://..."></label>' +
        '<label>Описание <span class="muted">(необязательно)</span><textarea name="description" rows="2" maxlength="1000" placeholder="Что находится по ссылке"></textarea></label>' +
        '<button class="btn primary" type="submit">Добавить ссылку</button>' +
      '</form></div>'
    : '<p class="material-student-note">Материалы добавляет староста. Ты можешь открывать и скачивать всё, что опубликовано для группы.</p>';
  const items = state.materials.length
    ? '<div class="material-list">' + state.materials.map(renderMaterialItem).join('') + '</div>'
    : empty('Материалов пока нет', canManage ? 'Загрузи первый файл или добавь полезную ссылку для группы.' : 'Староста ещё не добавил материалы.');
  return heading('БИБЛИОТЕКА', 'Материалы', 'Методички, ссылки, презентации и учебные файлы для всей группы.') +
    '<section class="panel material-library-panel"><div class="material-section-heading"><div><p class="eyebrow">ОБЩАЯ БИБЛИОТЕКА</p><h2>Материалы группы</h2></div><span class="material-count">' + state.materials.length + '</span></div>' +
    uploadPanel + items + '</section>' +
    '<section class="panel lecture-library-panel"><p class="eyebrow">ОТДЕЛЬНЫЙ РАЗДЕЛ</p><h2>Лекции</h2><p class="muted">Здесь будет отдельная библиотека лекций с распределением по дисциплинам. Пока материалы и ссылки добавляются в общую библиотеку группы.</p></section>';
}

function validateMaterialFile(file) {
  const allowed = /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt|rtf|jpe?g|png|webp|zip)$/i;
  if (!allowed.test(file.name)) throw new Error('Этот тип файла пока не поддерживается.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Размер файла не должен превышать 20 МБ.');
  if (!file.size) throw new Error('Файл пустой.');
}

async function removeStoredMaterialFile(groupId, materialId, storagePath = '') {
  const path = storagePath || `${groupId}/${materialId}`;
  const { error } = await supabase.storage.from('group-materials').remove([path]);
  if (error) throw error;
}

async function uploadGroupMaterial(form) {
  if (state.role !== 'leader') return notify('Добавлять материалы может только староста.', 'error');
  const data = new FormData(form);
  const file = data.get('file');
  const title = String(data.get('title') || '').trim();
  const description = String(data.get('description') || '').trim();
  if (!(file instanceof File) || !file.name) return notify('Выбери файл для загрузки.', 'error');
  if (!title || title.length > 180) return notify('Укажи название до 180 символов.', 'error');
  if (description.length > 1000) return notify('Описание слишком длинное.', 'error');
  try { validateMaterialFile(file); } catch (error) { return notify(error.message, 'error'); }
  setBusy(true);
  const materialId = crypto.randomUUID();
  const storagePath = `${state.group.id}/${materialId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  try {
    const { error: uploadError } = await supabase.storage.from('group-materials')
      .upload(storagePath, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (uploadError) throw uploadError;
    await setDoc(doc(collection(db, 'groups', state.group.id, 'materials'), materialId), {
      title, description, kind: 'file', fileName: file.name, contentType: file.type || 'application/octet-stream',
      size: file.size, fileStorage: 'supabase-storage', storagePath, createdBy: state.user.uid,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await loadWorkspace();
    renderWorkspace();
    notify('Файл добавлен в материалы группы.', 'success');
  } catch (error) {
    try { await removeStoredMaterialFile(state.group.id, materialId, storagePath); } catch {}
    console.error('STUDIUM material upload failed:', error);
    notify(error.message || 'Не удалось загрузить файл в Supabase Storage.', 'error');
  } finally { setBusy(false); }
}

async function addGroupMaterialLink(form) {
  if (state.role !== 'leader') return notify('Добавлять материалы может только староста.', 'error');
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  const description = String(data.get('description') || '').trim();
  const rawUrl = String(data.get('url') || '').trim();
  let url;
  try {
    url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Недопустимый протокол');
  } catch {
    return notify('Укажи корректную ссылку, начинающуюся с https:// или http://.', 'error');
  }
  if (!title || title.length > 180) return notify('Укажи название до 180 символов.', 'error');
  if (description.length > 1000 || url.href.length > 2048) return notify('Проверь длину описания и ссылки.', 'error');

  setBusy(true);
  try {
    await addDoc(collection(db, 'groups', state.group.id, 'materials'), {
      title, description, kind: 'link', externalUrl: url.href,
      createdBy: state.user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    notify('Ссылка добавлена в материалы группы.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    console.error('STUDIUM material link save failed:', error);
    notify(error.message || 'Не удалось сохранить ссылку. Проверь права доступа Supabase.', 'error');
  } finally {
    setBusy(false);
  }
}

async function openGroupMaterial(materialId) {
  const item = state.materials.find(material => material.id === materialId);
  if (!item?.storagePath || item.fileStorage !== 'supabase-storage') return notify('Файл не найден.', 'error');
  setBusy(true);
  try {
    const { data, error } = await supabase.storage.from('group-materials').createSignedUrl(item.storagePath, 60);
    if (error) throw error;
    const link = document.createElement('a');
    link.href = data.signedUrl;
    link.download = item.fileName || item.title || 'material';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) { notify(error.message || 'Не удалось скачать файл.', 'error'); }
  finally { setBusy(false); }
}

async function deleteGroupMaterial(materialId) {
  if (state.role !== 'leader') return notify('Удалять материалы может только староста.', 'error');
  const item = state.materials.find(material => material.id === materialId);
  if (!item) return;
  setBusy(true);
  try {
    if (item.fileStorage === 'supabase-storage' && item.storagePath) {
      await removeStoredMaterialFile(state.group.id, item.id, item.storagePath);
    }
    await deleteDoc(doc(db, 'groups', state.group.id, 'materials', materialId));
    notify('Материал удалён.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    console.error('STUDIUM material delete failed:', error);
    notify(error.message || 'Не удалось удалить материал. Проверь правила доступа.', 'error');
  } finally {
    setBusy(false);
  }
}

function renderCurrentTab() {
  if (state.tab === 'appearance') return renderAppearance();
  if (state.tab === 'profile') return renderProfile();
  if (state.tab === 'deadlines') return renderDeadlines();
  if (state.tab === 'tasks' || state.tab === 'schedule') return renderSchedule();
  if (state.tab === 'moderation' && state.role === 'leader') return renderModeration();
  if (state.tab === 'attendance') return renderAttendance();
  if (state.tab === 'library') return renderLibrary();
  if (state.tab === 'manage') return renderManage();
  return renderOverview();
}

const themeOptions = [
  { id: 'mono', name: 'Чёрно-белая классика', note: 'Чистый минимализм', colors: ['#FFFFFF','#EAEAEA','#171717','#B8B8B8'] },
  { id: 'bluegray', name: 'Холодный графит', note: 'Сдержанный технологичный стиль', colors: ['#F7F8F9','#DCE3E8','#252A2E','#AAB5BE'] },
  { id: 'beige', name: 'Тёплый бежевый', note: 'Мягкий и элегантный', colors: ['#FAF9F6','#EAE4DA','#252321','#B9AD9D'] },
  { id: 'olive', name: 'Оливковый камень', note: 'Спокойный академичный стиль', colors: ['#F8F9F6','#DFE2D9','#252923','#A9B09F'] },
  { id: 'slate', name: 'Сланец', note: 'Холодные стальные оттенки', colors: ['#F5F6F7','#DCE0E4','#29323A','#929DA7'] },
  { id: 'sand', name: 'Песчаник', note: 'Светлый природный оттенок', colors: ['#FBF8F2','#E9DDC9','#302A22','#B9A88E'] },
  { id: 'forest', name: 'Тёмный лес', note: 'Глубокий зелёно-серый акцент', colors: ['#F5F7F5','#DCE5DE','#25342B','#91A497'] },
  { id: 'lavender', name: 'Дымчатая лаванда', note: 'Мягкий холодный оттенок', colors: ['#F8F7FA','#E5E0EA','#302B36','#A69BAD'] },
];

function applyTheme(themeId) {
  const theme = themeOptions.find(item => item.id === themeId) || themeOptions[0];
  state.theme = theme.id;
  document.documentElement.dataset.theme = theme.id;
  localStorage.setItem('studium-theme', theme.id);
}

function renderAppearance() {
  return heading('ПЕРСОНАЛИЗАЦИЯ', 'Оформление', 'Выбери цветовую тему STUDIUM. Она сохранится на этом устройстве.') +
    '<section class="theme-settings-grid">' +
    themeOptions.map(theme => '<button type="button" class="theme-option' + (state.theme === theme.id ? ' active' : '') + '" data-theme-choice="' + theme.id + '" aria-pressed="' + (state.theme === theme.id) + '">' +
      '<span class="theme-swatches">' + theme.colors.map(color => '<i style="background:' + color + '"></i>').join('') + '</span>' +
      '<span class="theme-option-copy"><strong>' + theme.name + '</strong><small>' + theme.note + '</small></span>' +
      '<span class="theme-check">' + (state.theme === theme.id ? '✓' : '') + '</span>' +
    '</button>').join('') +
    '</section><p class="muted theme-footnote">Тема меняет фон, карточки расписания, кнопки и акцентные элементы. Выбор сохраняется только на этом устройстве.</p>';
}

function renderProfile() {
  const fullName = displayFullName(state.profile);
  const username = state.profile?.username || '';
  return heading('ЛИЧНЫЙ КАБИНЕТ', 'Мой профиль', 'Обнови свои данные. Изменения ФИО появятся в списке группы и журнале посещаемости.') +
    '<div class="profile-settings-grid">' +
      '<section class="panel profile-settings-card">' +
        '<p class="eyebrow">01 · ЛИЧНЫЕ ДАННЫЕ</p><h2>ФИО</h2>' +
        '<p class="muted">Одно поле для фамилии, имени и отчества.</p>' +
        '<form id="profile-form" class="form">' +
          '<label>ФИО полностью<input name="fullName" minlength="2" maxlength="80" autocomplete="name" required value="' + esc(fullName) + '" placeholder="Иванов Иван Иванович"></label>' +
          '<button class="btn primary" type="submit">Сохранить ФИО</button>' +
        '</form>' +
      '</section>' +
      '<section class="panel profile-settings-card">' +
        '<p class="eyebrow">02 · ЛОГИН</p><h2>Изменить логин</h2>' +
        '<p class="muted">Твой текущий логин уже подставлен. Просто измени его на новый.</p>' +
        '<form id="username-form" class="form">' +
          '<label>Логин<input name="username" type="text" minlength="3" maxlength="24" autocapitalize="none" spellcheck="false" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,23}" required value="' + esc(username) + '" placeholder="Логин"></label>' +
          '<label>Текущий пароль<input name="currentPassword" type="password" autocomplete="current-password" required placeholder="Для подтверждения личности"></label>' +
          '<small class="muted">После смены входи по новому логину. Пароль останется прежним.</small>' +
          '<button class="btn secondary" type="submit">Изменить логин</button>' +
        '</form>' +
      '</section>' +
      '<section class="panel profile-settings-card profile-password-card">' +
        '<p class="eyebrow">03 · БЕЗОПАСНОСТЬ</p><h2>Изменить пароль</h2>' +
        '<form id="password-form" class="form">' +
          '<label>Текущий пароль<input name="currentPassword" type="password" autocomplete="current-password" required placeholder="Текущий пароль"></label>' +
          '<div class="form-two-fields"><label>Новый пароль<input name="newPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="Не менее 8 символов"></label>' +
          '<label>Повтори новый пароль<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="Повтори пароль"></label></div>' +
          '<small class="muted">Минимум 8 символов. Новый пароль вступит в силу сразу после сохранения.</small>' +
          '<button class="btn secondary" type="submit">Обновить пароль</button>' +
        '</form>' +
      '</section>' +
    '</div>';
}

function taskDeadlineDate(task) {
  const value = task.dueDate || task.lessonDate || '';
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return localDateParts(date).iso;
}

function renderDeadlines() {
  const [year, month] = (state.deadlineMonth || today().slice(0, 7)).split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1, 12);
  const monthLabel = monthStart.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(year, month, 0).getDate();
  const leadingDays = (monthStart.getDay() + 6) % 7;
  const weekdayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const tasksByDate = new Map();

  state.tasks.forEach(task => {
    const date = taskDeadlineDate(task);
    if (!date) return;
    if (!tasksByDate.has(date)) tasksByDate.set(date, []);
    tasksByDate.get(date).push(task);
  });

  const monthTasks = Array.from(tasksByDate.entries())
    .filter(([date]) => date.startsWith(state.deadlineMonth))
    .flatMap(([, items]) => items);
  const monthCompleted = monthTasks.filter(task => state.progress.get(task.id) === true).length;

  const cells = [];
  for (let index = 0; index < leadingDays; index++) {
    cells.push('<div class="deadline-calendar-blank" aria-hidden="true"></div>');
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
    const dayTasks = tasksByDate.get(date) || [];
    const completed = dayTasks.filter(task => state.progress.get(task.id) === true).length;
    const allDone = dayTasks.length > 0 && completed === dayTasks.length;
    const selected = date === state.selectedDeadlineDate;
    const isToday = date === today();
    const statusClass = dayTasks.length ? (allDone ? ' has-deadlines all-complete' : ' has-deadlines has-pending') : '';
    const selectedClass = selected ? ' selected' : '';
    const todayClass = isToday ? ' today' : '';
    const countLabel = dayTasks.length ? '<small>' + completed + '/' + dayTasks.length + '</small>' : '';
    const ariaLabel = dateText(date) + (dayTasks.length ? ', выполнено ' + completed + ' из ' + dayTasks.length : ', нет заданий');
    cells.push(
      '<button type="button" class="deadline-calendar-day' + statusClass + selectedClass + todayClass +
      '" data-deadline-date="' + date + '" aria-pressed="' + selected + '" aria-label="' + esc(ariaLabel) + '">' +
      '<span class="deadline-day-number">' + day + '</span>' + countLabel +
      (dayTasks.length && allDone ? '<span class="deadline-day-check" aria-hidden="true">✓</span>' : '') +
      '</button>'
    );
  }

  const selectedTasks = (tasksByDate.get(state.selectedDeadlineDate) || []).slice().sort((a,b) =>
    String(a.lessonTime || '').localeCompare(String(b.lessonTime || '')) ||
    String(a.subject || '').localeCompare(String(b.subject || ''), 'ru')
  );
  const selectedDateLabel = state.selectedDeadlineDate
    ? new Date(state.selectedDeadlineDate + 'T12:00:00').toLocaleDateString('ru-RU', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      })
    : 'Выбери день';
  const selectedCompleted = selectedTasks.filter(task => state.progress.get(task.id) === true).length;
  const selectedSummary = selectedTasks.length
    ? '<span class="deadline-day-progress' + (selectedCompleted === selectedTasks.length ? ' complete' : '') + '">' +
      selectedCompleted + ' из ' + selectedTasks.length + ' выполнено</span>'
    : '';
  const selectedContent = selectedTasks.length
    ? (selectedCompleted === selectedTasks.length
        ? '<div class="deadline-complete-banner">✓ Все домашние задания на этот день выполнены</div>'
        : '<div class="deadline-pending-banner">Осталось выполнить: ' + (selectedTasks.length - selectedCompleted) + '</div>') +
      taskCards(selectedTasks)
    : empty('На этот день дедлайнов нет', 'Выбери другую дату в календаре или добавь ДЗ к паре в расписании.');

  return heading('УЧЕБНЫЙ ПРОЦЕСС', 'Дедлайны', 'Календарь домашних заданий и твой прогресс по каждому дню.') +
    '<section class="deadline-calendar-panel">' +
      '<div class="deadline-calendar-header">' +
        '<div><p class="eyebrow">КАЛЕНДАРЬ ДЕДЛАЙНОВ</p><h2>' + esc(monthLabel) + '</h2></div>' +
        '<div class="deadline-calendar-controls">' +
          '<button type="button" class="btn ghost" data-action="deadline-today">Сегодня</button>' +
          '<button type="button" class="deadline-month-arrow" data-action="deadline-month" data-offset="-1" aria-label="Предыдущий месяц">←</button>' +
          '<button type="button" class="deadline-month-arrow" data-action="deadline-month" data-offset="1" aria-label="Следующий месяц">→</button>' +
        '</div>' +
      '</div>' +
      '<div class="deadline-month-progress"><span>Выполнено в этом месяце</span><strong>' + monthCompleted + ' / ' + monthTasks.length + '</strong></div>' +
      '<div class="deadline-calendar-grid deadline-weekdays">' + weekdayLabels.map(label => '<span>' + label + '</span>').join('') + '</div>' +
      '<div class="deadline-calendar-grid deadline-days">' + cells.join('') + '</div>' +
      '<div class="deadline-calendar-legend">' +
        '<span><i class="legend-dot complete"></i>Всё выполнено</span>' +
        '<span><i class="legend-dot pending"></i>Есть невыполненные</span>' +
        '<span><i class="legend-dot no-deadlines"></i>Нет ДЗ</span>' +
      '</div>' +
    '</section>' +
    '<section class="deadline-selected-section">' +
      '<div class="deadline-selected-heading"><div><p class="eyebrow">ВЫБРАННЫЙ ДЕНЬ</p><h2>' + esc(selectedDateLabel) + '</h2></div>' + selectedSummary + '</div>' +
      selectedContent +
    '</section>';
}

function renderOverview() {
  const pending = state.suggestions.filter(item => item.status === 'pending').length;
  const completed = state.tasks.filter(item => state.progress.get(item.id)).length;
  const nearestDeadline = state.tasks.find(item => item.lessonDate || item.dueDate);
  const deadlineDate = nearestDeadline?.dueDate || nearestDeadline?.lessonDate;
  const deadlineDetail = nearestDeadline
    ? '<small class="muted date-stat-detail">' + esc(nearestDeadline.subject || 'Домашнее задание') +
      (nearestDeadline.title ? ' · ' + esc(nearestDeadline.title) : '') + '</small>'
    : '';
  const nextLesson = state.lessons
    .map(lesson => ({ lesson, date: nextLessonDate(lesson) }))
    .filter(item => item.date)
    .sort((a,b) => a.date.localeCompare(b.date) ||
      (timeToMinutes(a.lesson.startsAt) ?? 0) - (timeToMinutes(b.lesson.startsAt) ?? 0))[0];
  const nextLessonDetail = nextLesson
    ? '<small class="muted date-stat-detail">' + esc(nextLesson.lesson.subject || 'Занятие') +
      (nextLesson.lesson.startsAt ? ' · ' + esc(nextLesson.lesson.startsAt) : '') + '</small>'
    : '';
  const studentLessonStat = state.role !== 'leader'
    ? '<article><small>Ближайшая пара</small><strong class="date-stat">' +
      esc(nextLesson ? dateText(nextLesson.date) : 'Нет пар в расписании') + '</strong>' + nextLessonDetail + '</article>'
    : '';
  const moderationStat = state.role === 'leader'
    ? '<article><small>На модерации</small><strong>' + pending + '</strong></article>'
    : '';
  return heading('STUDIUM / ОБЗОР', 'Добро пожаловать', esc(displayFullName(state.profile)), '<button class="btn primary" data-tab="tasks">Открыть задания →</button>') +
    '<div class="stats"><article><small>Заданий в группе</small><strong>' + state.tasks.length + '</strong></article><article><small>Выполнено тобой</small><strong>' + completed + '</strong></article><article><small>Ближайший дедлайн</small><strong class="date-stat">' + esc(deadlineDate ? dateText(deadlineDate) : 'Нет заданий') + '</strong>' + deadlineDetail + '</article>' + moderationStat + studentLessonStat + '</div>' +
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
    const deleteButton = state.role === 'leader'
      ? '<button type="button" class="task-delete-button" data-action="delete-task" data-id="' + esc(task.id) + '">Удалить ДЗ</button>'
      : '';
    const attachments = (task.attachments || []).map((file,index) => '<button type="button" class="task-attachment-link" data-action="open-task-attachment" data-task-id="' + esc(task.id) + '" data-attachment-index="' + index + '">↧ ' + esc(file.name || 'Файл ' + (index + 1)) + '</button>').join('');
    const attachmentUrl = task.attachmentUrl ? '<a class="task-attachment-link" href="' + esc(task.attachmentUrl) + '" target="_blank" rel="noopener noreferrer">↗ Открыть ссылку</a>' : '';
    return '<article data-key="task-' + esc(task.id) + '" class="task-card ' + (done ? 'done' : '') + '"><div class="task-copy"><small>' + esc(task.subject || 'Без предмета') + '</small><h3>' + esc(task.title) + '</h3><div class="task-attachments">' + attachments + attachmentUrl + '</div><div class="meta"><span>Пара: ' + esc(pairLabel || dateLabel) + '</span></div></div><div class="task-card-actions"><label class="check"><input type="checkbox" data-progress="' + esc(task.id) + '" ' + (done ? 'checked' : '') + '> Выполнено</label>' + deleteButton + '</div></article>';
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
    '<div class="task-attachments-fields"><label>Файлы <span class="muted">(можно несколько)</span><input type="file" name="attachments" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.rtf,.jpg,.jpeg,.png,.webp,.zip"></label>' +
    '<label>Ссылка <span class="muted">(необязательно)</span><input type="url" name="attachmentUrl" maxlength="2048" placeholder="https://..."></label></div>' +
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
  // Only one homework entry is allowed per lesson. The live tasks listener
  // removes the compose form automatically as soon as a task is published.
  const compose = selectedLesson && visibleTasks.length === 0 ? taskForm(selectedLesson) : '';
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
  const homework = state.tasks.find(task => task.lessonId === lesson.id);
  const homeworkMarkup = homework
    ? '<div class="schedule-homework-preview"><span>ДЗ</span><strong>' + esc(homework.title || 'Задание опубликовано') + '</strong>' +
      (homework.description ? '<small>' + esc(homework.description) + '</small>' : '') + '</div>'
    : '<button type="button" class="schedule-homework-action" data-action="open-lesson-homework" data-id="' + esc(lesson.id) + '">' +
      (state.role === 'leader' ? 'Добавить ДЗ' : 'Предложить ДЗ') + '</button>';
  return '<article class="schedule-lesson ' + (lesson.lessonType === 'lecture' ? 'lecture-lesson' : 'seminar-lesson') + (span > 1 ? ' double-period' : '') + (selected ? ' selected-lesson' : '') +
    '" style="grid-row:span ' + span + '" data-schedule-lesson data-id="' + esc(lesson.id) +
    '" role="button" tabindex="0" aria-pressed="' + selected + '" aria-label="Показать задания: ' + esc(lesson.subject) + '">' +
    '<div class="schedule-times">' + times + '</div>' +
    '<strong>' + esc(lesson.subject) + '</strong>' +
     '<span class="schedule-lesson-type-label">' + (lesson.lessonType === 'seminar' ? 'Семинар' : 'Лекция') + '</span>' +
    (lesson.room ? '<small class="schedule-room">' + esc(lesson.room) + '</small>' : '') +
    (lesson.description ? '<p class="schedule-description">' + esc(lesson.description) + '</p>' : '') +
    homeworkMarkup +
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
                '<label>Тип занятия<select name="lessonType"><option value="lecture">Лекция</option><option value="seminar">Семинар</option></select></label>' +
                '<label>Длительность<select name="periodCount">' + durationOptions + '</select></label>' +
              '</div>' +
              '<label>Аудитория<input name="room" maxlength="60" placeholder="Ауд."></label>' +
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
    '<div class="schedule-slots" style="grid-template-rows:repeat(' + schedulePeriods.length + ',minmax(0,1fr))">' + slotMarkup.join('') + '</div>' +
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

function attendanceParts(lesson) {
  const startIndex = lessonStartIndex(lesson);
  const span = startIndex >= 0 ? lessonSpan(lesson, startIndex) : 1;
  if (span <= 1 || startIndex < 0) {
    return [{ partKey: null, label: '', startsAt: lesson.startsAt || '', endsAt: lesson.endsAt || '' }];
  }
  return schedulePeriods.slice(startIndex, startIndex + span).map((period, index) => ({
    partKey: 'part' + (index + 1),
    label: (index + 1) + '-я часть',
    startsAt: period.start,
    endsAt: period.end
  }));
}

function attendancePartMatches(item, partKey) {
  if (!partKey) return !item.partKey;
  // Old one-entry attendance is used as a baseline for both parts until a
  // student or leader records a part-specific value.
  return item.partKey === partKey || !item.partKey;
}

function attendanceItemForPart(items, lessonId, personId, partKey, personField) {
  const candidates = items.filter(item =>
    item.lessonId === lessonId &&
    item.lessonDate === state.attendanceDate &&
    item[personField] === personId
  );
  if (partKey) {
    return candidates.find(item => item.partKey === partKey) ||
      candidates.find(item => !item.partKey) || null;
  }
  return candidates.find(item => !item.partKey) || null;
}

function attendanceMapForPart(items, lessonId, partKey, personField) {
  const map = new Map();
  items.filter(item =>
    item.lessonId === lessonId &&
    item.lessonDate === state.attendanceDate &&
    attendancePartMatches(item, partKey)
  ).forEach(item => {
    const personId = item[personField];
    if (!map.has(personId) || (partKey && item.partKey === partKey)) {
      map.set(personId, item);
    }
  });
  return map;
}

function attendanceDocumentId(lessonId, personId, partKey) {
  return partKey
    ? lessonId + '_' + state.attendanceDate + '_' + partKey + '_' + personId
    : lessonId + '_' + state.attendanceDate + '_' + personId;
}

function attendanceResponseLabel(response) {
  if (response === 'will_attend') return '<span class="attendance-response will-attend">Будет на паре</span>';
  if (response === 'will_miss') return '<span class="attendance-response will-miss">Не будет</span>';
  return '<span class="attendance-response no-response">Нет ответа</span>';
}

function attendanceStatusLabel(status) {
  return ({ present: 'Был', absent: 'Неуваж.', excused: 'Уваж.', late: 'Опоздал' })[status] || 'Не отмечен';
}

function renderAttendanceRoster(lesson, partKey = null) {
  const parts = attendanceParts(lesson);
  const part = parts.find(item => item.partKey === partKey) || parts[0];
  partKey = part?.partKey ?? null;
  const members = state.groupMembers.slice().sort((a,b) =>
    String(a.displayName || a.fullName || a.username || '').localeCompare(
      String(b.displayName || b.fullName || b.username || ''), 'ru', { sensitivity: 'base' }
    )
  );
  const responses = attendanceMapForPart(state.attendance, lesson.id, partKey, 'userId');
  const records = attendanceMapForPart(state.attendanceRecords, lesson.id, partKey, 'studentId');
  const missed = members.filter(member => responses.get(member.id)?.response === 'will_miss');
  const counts = {
    present: members.filter(member => records.get(member.id)?.status === 'present').length,
    absent: members.filter(member => records.get(member.id)?.status === 'absent').length,
    excused: members.filter(member => records.get(member.id)?.status === 'excused').length
  };
  const partAttribute = partKey ? ' data-part-key="' + esc(partKey) + '"' : '';
  const bulkButton = members.length
    ? '<button class="attendance-bulk-present" type="button" data-action="mark-all-present" data-lesson="' + esc(lesson.id) + '"' + partAttribute + '>Всем поставить «Был» (' + members.length + ')</button>' +
      (missed.length
        ? '<button class="attendance-bulk-excuse" type="button" data-action="excuse-all-missed" data-lesson="' + esc(lesson.id) + '"' + partAttribute + '>Поставить «Уваж.» всем, кто ответил «Не буду» (' + missed.length + ')</button>'
        : '')
    : '';

  const rows = members.map(member => {
    const userId = member.id || member.userId;
    const name = member.displayName || member.fullName || member.username || 'Участник';
    const response = responses.get(userId)?.response || '';
    const officialStatus = records.get(userId)?.status || '';
    // Student response preselects a provisional register button. The leader's
    // official mark always takes precedence and can be changed independently.
    const suggestedStatus = response === 'will_attend' ? 'present'
      : (response === 'will_miss' ? 'absent' : '');
    const role = member.role === 'leader' ? '<span class="roster-role">Староста</span>' : '';
    const responseText = response === 'will_attend' ? 'Ответ: будет на этой части'
      : (response === 'will_miss' ? 'Ответ: не будет на этой части · причину обсудить со старостой' : 'Ответ: пока не дан');
    const responseClass = response === 'will_attend' ? ' positive'
      : (response === 'will_miss' ? ' negative' : '');
    const lateNote = officialStatus === 'late' ? '<span class="roster-late-note">Последняя отметка: опоздал</span>' : '';
    const mark = (value, label, cls) => {
      const isOfficial = officialStatus === value;
      const isSuggested = !officialStatus && suggestedStatus === value;
      return '<button type="button" class="attendance-mark ' + cls +
      (isOfficial ? ' active' : (isSuggested ? ' suggested' : '')) +
      '" data-official-status="' + value + '" data-student="' + esc(userId) +
      '" data-lesson="' + esc(lesson.id) + '"' + partAttribute +
      ' aria-pressed="' + (isOfficial || isSuggested) + '"' +
      (isSuggested ? ' title="Предварительно по ответу студента; подтвердите отметку"' : '') +
      '>' + label + '</button>';
    };
    return '<article data-key="attendance-person-' + esc(userId) + '-' + esc(partKey || 'whole') + '" class="attendance-person-row"><div class="attendance-person-info"><strong>' + esc(name) + '</strong>' + role +
      '<small class="attendance-person-response' + responseClass + '">' + responseText + '</small>' + lateNote + '</div>' +
      '<div class="attendance-mark-buttons">' +
      mark('present', 'Был', 'mark-present') +
      mark('absent', 'Неуваж.', 'mark-absent') +
      mark('excused', 'Уваж.', 'mark-excused') +
      '</div></article>';
  }).join('');

  const partSelector = parts.length > 1
    ? '<div class="attendance-part-selector">' + parts.map(item =>
        '<button type="button" class="attendance-part-tab' + (item.partKey === partKey ? ' active' : '') +
        '" data-attendance-part="' + esc(item.partKey) + '" data-lesson="' + esc(lesson.id) + '">' +
        '<strong>' + esc(item.label) + '</strong><small>' + esc(item.startsAt + '–' + item.endsAt) + '</small></button>'
      ).join('') + '</div>'
    : '';
  const partHeading = parts.length > 1
    ? '<p class="muted">' + esc(part.label + ' · ' + part.startsAt + '–' + part.endsAt) + ' · ' + esc(dateText(state.attendanceDate)) + '</p>'
    : '<p class="muted">' + esc(lesson.startsAt || '') + (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') + ' · ' + esc(dateText(state.attendanceDate)) + '</p>';

  return '<section class="attendance-register"><div class="attendance-register-head"><div><p class="eyebrow">ОФИЦИАЛЬНЫЙ ЖУРНАЛ</p><h2>' + esc(lesson.subject) + '</h2>' + partHeading + '</div>' +
    '<div class="attendance-register-count">' + members.length + ' чел.</div></div>' +
    partSelector +
    '<div class="attendance-register-summary"><span>Был: <b>' + counts.present + '</b></span><span>Неуваж.: <b>' + counts.absent + '</b></span><span>Уваж.: <b>' + counts.excused + '</b></span></div>' +
    (bulkButton ? '<div class="attendance-bulk-row">' + bulkButton + '</div>' : '') +
    (rows ? '<div class="attendance-roster">' + rows + '</div>' : empty('В группе пока нет участников', 'Когда студенты вступят в группу, они появятся здесь.')) +
    '<p class="muted small attendance-register-footnote">Предварительный ответ оставляет студент отдельно по каждой части. Кнопки справа — официальная отметка старосты для выбранной части пары.</p></section>';
}

function renderStudentAttendance(lessons, date) {
  const profileName = displayFullName(state.profile);
  const [year, month, day] = date.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day, 12);
  const dateLabel = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const weekdayLabel = dateObj.toLocaleDateString('ru-RU', { weekday: 'long' });
  const entries = lessons.flatMap(lesson =>
    attendanceParts(lesson).map(part => ({ lesson, part }))
  );
  const responseFor = (lesson, partKey) =>
    attendanceItemForPart(state.attendance, lesson.id, state.user.uid, partKey, 'userId')?.response || '';
  const attendedCount = entries.filter(item => responseFor(item.lesson, item.part.partKey) === 'will_attend').length;
  const missedCount = entries.filter(item => responseFor(item.lesson, item.part.partKey) === 'will_miss').length;
  const allAttend = entries.length > 0 && attendedCount === entries.length;
  const allMiss = entries.length > 0 && missedCount === entries.length;
  const quick = entries.length
    ? '<div class="attendance-all-actions">' +
      '<button type="button" class="attendance-all-button' + (allAttend ? ' active' : '') + '" data-attendance-all="will_attend">Буду на всех парах</button>' +
      '<button type="button" class="attendance-all-button' + (allMiss ? ' active' : '') + '" data-attendance-all="will_miss">Не буду на всех парах</button>' +
      '</div>' : '';
  const cards = lessons.map((lesson,index) => {
    const parts = attendanceParts(lesson);
    const double = parts.length > 1;
    const partCards = parts.map(part => {
      const response = responseFor(lesson, part.partKey);
      const partTitle = double
        ? '<div class="attendance-subpart-heading"><strong>' + esc(part.label) + '</strong><span>' + esc(part.startsAt + '–' + part.endsAt) + '</span></div>'
        : '';
      const partAttribute = part.partKey ? ' data-part-key="' + esc(part.partKey) + '"' : '';
      return '<div class="attendance-subpart' + (double ? ' is-split' : '') + '">' + partTitle +
        '<div class="student-attendance-lesson-actions">' +
        '<button type="button" class="attendance-choice' + (response === 'will_attend' ? ' active attend' : '') + '" data-attendance="will_attend" data-lesson="' + esc(lesson.id) + '"' + partAttribute + '>Буду</button>' +
        '<button type="button" class="attendance-choice' + (response === 'will_miss' ? ' active miss' : '') + '" data-attendance="will_miss" data-lesson="' + esc(lesson.id) + '"' + partAttribute + '>Не буду</button>' +
        '</div>' +
        (double && response ? '<div class="attendance-subpart-response">' + attendanceResponseLabel(response) + '</div>' : '') +
        '</div>';
    }).join('');
    return '<article data-key="student-attendance-' + esc(lesson.id) + '" class="student-attendance-lesson' + (double ? ' has-split-parts' : '') + '"><div class="student-attendance-lesson-title"><div>' +
      '<small>' + (index + 1) + ' пара · ' + esc(lesson.startsAt || '') + (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') + '</small>' +
      '<h2>' + esc(lesson.subject) + '</h2>' + (lesson.room ? '<p>' + esc(lesson.room) + '</p>' : '') +
      '</div>' + (!double && parts.length ? attendanceResponseLabel(responseFor(lesson, null)) : '') + '</div>' +
      '<div class="attendance-subparts">' + partCards + '</div></article>';
  }).join('');
  return '<section class="student-attendance-page"><header class="student-attendance-header"><div><h1>' + esc(profileName) + '</h1><p>' + esc(dateLabel) + ', ' + esc(weekdayLabel) + '</p></div>' +
    '<div class="student-attendance-date"><label for="attendance-date">Дата</label><input type="date" id="attendance-date" value="' + date + '"></div></header>' +
    '<p class="student-attendance-caption">Отметь, будешь ли ты на занятиях. У двойной пары можно ответить отдельно по каждой части. Староста увидит твои ответы.</p>' + quick +
    (lessons.length ? '<div class="student-attendance-lessons">' + cards + '</div>' : empty('На эту дату пар нет', 'Выбери другую дату или проверь расписание группы.')) +
    '</section>';
}

function renderAttendanceReportToolbar() {
  return '<section class="attendance-report-toolbar"><div><p class="eyebrow">ЭКСПОРТ ОТЧЁТА</p><strong>Месячная ведомость посещаемости</strong><p class="muted">В Excel попадут только официальные отметки старосты — ответы студентов не учитываются.</p></div>' +
    '<div class="attendance-report-controls"><label>Месяц<input type="month" id="attendance-report-month" value="' + today().slice(0, 7) + '"></label>' +
    '<button type="button" class="btn primary" data-action="export-attendance-report">Скачать Excel</button></div></section>';
}

async function exportAttendanceReport(month) {
  if (state.role !== 'leader') return;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    notify('Выбери месяц для отчёта.', 'error');
    return;
  }

  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const fromDate = month + '-01';
  const toDate = month + '-' + String(lastDay).padStart(2, '0');

  setBusy(true);
  try {
    const recordsSnapshot = await getDocs(query(
      collection(db, 'groups', state.group.id, 'attendanceRecords'),
      where('lessonDate', '>=', fromDate),
      where('lessonDate', '<=', toDate)
    ));
    // Report strictly follows the leader's official journal buttons.
    // Student self-reported answers create source='student_response' records
    // and are intentionally excluded from this export.
    const leaderRecords = recordsSnapshot.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .filter(item => item.source === 'leader');

    const result = await downloadAttendanceReport({
      month,
      groupName: state.group.name || 'Учебная группа',
      leaderName: displayFullName(state.profile),
      members: state.groupMembers,
      lessons: state.lessons,
      records: leaderRecords,
      specialty: state.group.specialty || '',
      course: state.group.course || ''
    });

    const monthLabel = new Date(year, monthNumber - 1, 1, 12)
      .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    notify(
      result.eventCount
        ? 'Отчёт за ' + monthLabel + ' скачан. Учтено официальных пропусков: ' + result.eventCount + '.'
        : 'Отчёт за ' + monthLabel + ' скачан. Официальных пропусков за этот месяц пока нет.',
      'success'
    );
  } catch (error) {
    console.error('STUDIUM attendance report:', error);
    notify(error.message || 'Не удалось сформировать Excel-отчёт.', 'error');
  } finally {
    setBusy(false);
  }
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
    const parts = attendanceParts(lesson);
    const partSummaries = parts.map(part => {
      const resolved = state.groupMembers.map(member =>
        attendanceItemForPart(state.attendance, lesson.id, member.id || member.userId, part.partKey, 'userId')
      ).filter(Boolean);
      const attending = resolved.filter(item => item.response === 'will_attend').length;
      const missing = resolved.filter(item => item.response === 'will_miss').length;
      return parts.length > 1
        ? '<small>' + esc(part.label) + ': будут ' + attending + ' · не будут ' + missing + '</small>'
        : '<small>Будут: ' + attending + ' · Не будут: ' + missing + '</small>';
    }).join('');
    return '<button type="button" class="attendance-lesson-card' + (selected?.id === lesson.id ? ' selected' : '') +
      '" data-attendance-lesson="' + esc(lesson.id) + '"><span>' + (index + 1) + ' пара · ' +
      esc(lesson.startsAt || '') + (lesson.endsAt ? '–' + esc(lesson.endsAt) : '') +
      '</span><strong>' + esc(lesson.subject) + '</strong>' + partSummaries + '</button>';
  }).join('');
  const [year,month,day] = date.split('-').map(Number);
  const dateLabel = new Date(year,month-1,day,12).toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'long'});
  const selectedParts = selected ? attendanceParts(selected) : [];
  const selectedPartKey = selectedParts.length > 1
    ? (selectedParts.some(part => part.partKey === state.selectedAttendancePartKey)
        ? state.selectedAttendancePartKey
        : selectedParts[0].partKey)
    : null;
  return heading('ПОСЕЩАЕМОСТЬ', 'Журнал старосты', 'Выбери пару и отмечай посещаемость по списку группы.') +
    renderAttendanceReportToolbar() +
    '<div class="date-picker attendance-date-leader"><label>Дата<input type="date" id="attendance-date" value="' + date + '"></label><span>' + esc(dateLabel) + ' · ' + (week === 1 ? 'Первая' : 'Вторая') + ' учебная неделя</span></div>' +
    (lessons.length ? '<div class="attendance-lesson-grid">' + cards + '</div>' : empty('На эту дату пар нет', 'Выбери другую дату или проверь расписание группы.')) +
    (selected ? renderAttendanceRoster(selected, selectedPartKey) : (lessons.length ? '<p class="muted small attendance-pick-hint">Нажми на пару выше — откроется список группы по алфавиту.</p>' : ''));
}

async function saveAttendance(lessonId, response, partKey = null) {
  setBusy(true);
  try {
    const { error } = await supabase.rpc('save_my_attendance_response', {
      p_group_id: state.group.id,
      p_lesson_id: lessonId,
      p_lesson_date: state.attendanceDate,
      p_part_key: partKey || '',
      p_response: response
    });
    if (error) throw error;

    // Update the local view immediately after the server confirms the write.
    // Keep the same ID format used by attendanceDocumentId() and the register.
    const responseId = attendanceDocumentId(lessonId, state.user.uid, partKey);
    const savedResponse = {
      id: responseId,
      lessonId,
      userId: state.user.uid,
      lessonDate: state.attendanceDate,
      ...(partKey ? { partKey } : {}),
      response,
      updatedAt: new Date().toISOString()
    };
    state.attendance = [
      ...state.attendance.filter(item => item.id !== responseId),
      savedResponse
    ];
    renderWorkspace();

    // Refresh from Supabase as a consistency check; the confirmed local state
    // remains visible even if a subsequent read is delayed.
    try {
      await loadWorkspace();
      renderWorkspace();
    } catch (refreshError) {
      console.error('STUDIUM attendance refresh failed:', refreshError);
    }
    notify(response === 'will_attend' ? 'Ответ сохранён: будешь на занятии.' : 'Ответ сохранён: не будешь на занятии.', 'success');
  } catch (error) {
    console.error('STUDIUM attendance response save failed:', error);
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
  const entries = lessons.flatMap(lesson =>
    attendanceParts(lesson).map(part => ({ lesson, part }))
  );
  if (!entries.length) return notify('На эту дату пар нет.');
  setBusy(true);
  try {
    const results = await Promise.all(entries.map(({lesson,part}) =>
      supabase.rpc('save_my_attendance_response', {
        p_group_id: state.group.id,
        p_lesson_id: lesson.id,
        p_lesson_date: state.attendanceDate,
        p_part_key: part.partKey || '',
        p_response: response
      })
    ));
    const failed = results.find(result => result.error);
    if (failed?.error) throw failed.error;

    const savedAt = new Date().toISOString();
    const savedRows = entries.map(({lesson,part}) => {
      const id = attendanceDocumentId(lesson.id, state.user.uid, part.partKey);
      return {
        id,
        lessonId: lesson.id,
        userId: state.user.uid,
        lessonDate: state.attendanceDate,
        ...(part.partKey ? { partKey: part.partKey } : {}),
        response,
        updatedAt: savedAt
      };
    });
    const savedIds = new Set(savedRows.map(item => item.id));
    state.attendance = [
      ...state.attendance.filter(item => !savedIds.has(item.id)),
      ...savedRows
    ];
    renderWorkspace();

    try {
      await loadWorkspace();
      renderWorkspace();
    } catch (refreshError) {
      console.error('STUDIUM bulk attendance refresh failed:', refreshError);
    }
    notify(response === 'will_attend'
      ? 'Ответ сохранён для всех пар и частей.'
      : 'Ответ сохранён для всех пар и частей.');
  } catch (error) {
    console.error('STUDIUM bulk attendance response save failed:', error);
    notify(error.message || 'Не удалось сохранить ответы на все пары.', 'error');
  } finally {
    setBusy(false);
  }
}

function attendanceRecordRef(lessonId, studentId, partKey = null) {
  const recordId = attendanceDocumentId(lessonId, studentId, partKey);
  return doc(db, 'groups', state.group.id, 'attendanceRecords', recordId);
}

async function saveOfficialAttendance(studentId, lessonId, status, partKey = null) {
  if (state.role !== 'leader') return;
  const ref = attendanceRecordRef(lessonId, studentId, partKey);
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
        ...(partKey ? { partKey } : {}),
        status,
        reason: '',
        source: 'leader',
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

async function markAllPresent(lessonId, partKey = null) {
  if (state.role !== 'leader') return;
  const members = state.groupMembers || [];
  if (!members.length) {
    notify('В группе пока нет участников.');
    return;
  }

  setBusy(true);
  try {
    for (let offset = 0; offset < members.length; offset += 450) {
      const batch = writeBatch(db);
      members.slice(offset, offset + 450).forEach(member => {
        const studentId = member.id || member.userId;
        batch.set(attendanceRecordRef(lessonId, studentId, partKey), {
          studentId,
          lessonId,
          lessonDate: state.attendanceDate,
          ...(partKey ? { partKey } : {}),
          status: 'present',
          reason: '',
          source: 'leader',
          markedBy: state.user.uid,
          markedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
    }
    notify('Всем ' + members.length + ' участникам выставлена отметка «Был».', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    notify(error.message || 'Не удалось отметить всех присутствующими.', 'error');
  } finally {
    setBusy(false);
  }
}

async function excuseMissedStudents(lessonId, onlyStudentId = null, partKey = null) {
  if (state.role !== 'leader') return;
  const missing = state.groupMembers
    .map(member => {
      const userId = member.id || member.userId;
      const response = attendanceItemForPart(state.attendance, lessonId, userId, partKey, 'userId');
      return response?.response === 'will_miss' && (!onlyStudentId || userId === onlyStudentId)
        ? { userId }
        : null;
    })
    .filter(Boolean);
  if (!missing.length) {
    notify('Нет студентов с ответом «Не буду» на выбранную часть.');
    return;
  }
  // Apply the official excuse mark immediately; the leader can change it later.
  setBusy(true);
  try {
    for (let offset = 0; offset < missing.length; offset += 450) {
      const batch = writeBatch(db);
      missing.slice(offset, offset + 450).forEach(item => {
        batch.set(attendanceRecordRef(lessonId, item.userId, partKey), {
          studentId: item.userId,
          lessonId,
          lessonDate: state.attendanceDate,
          ...(partKey ? { partKey } : {}),
          status: 'excused',
          reason: 'Уважительная причина — предварительный ответ «Не буду»',
          source: 'leader',
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

async function deleteTask(taskId) {
  if (state.role !== 'leader') return;
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) {
    notify('Задание не найдено или уже удалено.', 'error');
    return;
  }

  setBusy(true);
  try {
    const progressSnapshot = await getDocs(query(
      collection(db, 'groups', state.group.id, 'taskProgress'),
      where('taskId', '==', taskId)
    ));

    for (let offset = 0; offset < progressSnapshot.docs.length; offset += 450) {
      const batch = writeBatch(db);
      progressSnapshot.docs.slice(offset, offset + 450).forEach(progressDoc => {
        batch.delete(progressDoc.ref);
      });
      await batch.commit();
    }

    await deleteDoc(doc(db, 'groups', state.group.id, 'tasks', taskId));
    notify('Домашнее задание удалено.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    console.error('STUDIUM: failed to delete task', error);
    notify(error.message || 'Не удалось удалить домашнее задание.', 'error');
  } finally {
    setBusy(false);
  }
}

function renderManage() {
  const members = state.groupMembers.slice().sort((a,b) =>
    String(a.displayName || a.username || '').localeCompare(
      String(b.displayName || b.username || ''), 'ru', { sensitivity: 'base' }
    )
  );
  const leader = state.role === 'leader';
  const code = state.activeMembership?.inviteCode || '';
  const switcher = state.memberships.length > 1
    ? '<label class="field-label group-switch-field">Переключить группу<select id="group-switch">' +
      state.memberships.map(item => '<option value="' + esc(item.groupId) + '" ' +
        (item.groupId === state.group.id ? 'selected' : '') + '>' + esc(item.name || 'Учебная группа') + '</option>').join('') +
      '</select></label>'
    : '';

  const invite = leader
    ? '<section class="group-invite-card"><div><p class="eyebrow">КОД ПРИГЛАШЕНИЯ</p>' +
      '<h2>' + esc(code || 'Код не найден') + '</h2>' +
      '<p class="muted">Отправь этот код студентам, чтобы они могли присоединиться к группе.</p></div>' +
      (code ? '<button type="button" class="btn primary" data-action="copy-code">Скопировать код</button>' : '') +
      '</section>'
    : '<p class="muted group-student-note">Ты состоишь в этой учебной группе. Список участников доступен всем членам группы.</p>';

  const rows = members.map((member,index) => {
    const name = member.displayName || member.fullName || member.username || 'Участник';
    const isLeader = member.role === 'leader';
    const isCurrent = member.id === state.user.uid;
    const initials = name.trim().split(/\s+/).slice(0,2).map(part => part[0] || '').join('').toUpperCase();
    return '<article class="group-member-row">' +
      '<span class="group-member-avatar">' + esc(initials || 'У') + '</span>' +
      '<div class="group-member-name"><strong>' + esc(name) + (isCurrent ? ' <span class="group-you-label">Это вы</span>' : '') + '</strong>' +
      '<small>' + (isLeader ? 'Староста' : 'Студент') + '</small></div>' +
      (isLeader ? '<span class="group-member-role">Староста</span>' : '<span class="group-member-role student">Студент</span>') +
      '</article>';
  }).join('');

  return heading('ПРОСТРАНСТВО ГРУППЫ', 'Наша группа', 'Информация об учебной группе и её участниках.') +
    '<div class="group-overview">' +
      '<section class="panel group-summary-card"><p class="eyebrow">УЧЕБНАЯ ГРУППА</p><h2>' + esc(state.group.name || 'Учебная группа') + '</h2>' +
      '<p class="muted">' + members.length + ' ' + (members.length === 1 ? 'участник' : (members.length < 5 ? 'участника' : 'участников')) + '</p>' +
      '<span class="role">' + (leader ? 'Ты — староста' : 'Ты — участник группы') + '</span></section>' +
      invite + switcher +
    '</div>' +
    '<section class="group-members-section"><div class="group-members-heading"><div><p class="eyebrow">СОСТАВ ГРУППЫ</p><h2>Все участники</h2></div><span class="group-members-count">' + members.length + '</span></div>' +
      (rows ? '<div class="group-members-list">' + rows + '</div>' : empty('Пока никого нет', 'Участники появятся в этом списке после присоединения к группе.')) +
    '</section>' +
    (leader ? '<section class="panel group-cycle-panel"><h2>Учебный цикл</h2><p class="muted">Укажи понедельник, с которого начинается первая учебная неделя.</p><form id="cycle-form" class="form"><label>Начало первой учебной недели<input name="studyCycleStart" type="date" value="' + esc(state.group.studyCycleStart || '') + '" required></label><button class="btn secondary">Сохранить учебный цикл</button></form></section>' : '');
}

async function submitAuth(form) {
  const data = new FormData(form);
  const username = normalizeUsername(data.get('username'));
  const password = String(data.get('password') || '');
  setBusy(true);
  try {
    if (data.has('full_name')) {
      const fullName = String(data.get('full_name') || '').trim().replace(/\s+/g, ' ');
      await signUpWithUsername({ username, password, fullName });
    } else {
      await signInWithUsername({ username, password });
    }
    const { data: sessionData, error } = await supabase.auth.getSession();
    if (error) throw error;
    await boot(sessionData.session?.user || null);
  } catch (error) {
    notify(error.message || 'Ошибка авторизации.', 'error');
  } finally {
    setBusy(false);
  }
}

async function reauthenticateCurrentUser(currentPassword) {
  const username = state.profile?.username;
  if (!username) throw new Error('Не удалось определить логин аккаунта.');
  await signInWithUsername({ username, password: currentPassword });
}

function profilePermissionMessage(error) {
  if (error?.code === '42501' || error?.code === 'PGRST301') {
    return 'Supabase отклонил изменение из-за прав доступа. Проверь RLS-политики проекта.';
  }
  if (error?.code === 'auth/wrong-password' || error?.code === 'auth/invalid-credential') {
    return 'Текущий пароль указан неверно.';
  }
  if (error?.code === 'auth/requires-recent-login') {
    return 'Подтверди личность текущим паролем и повтори действие.';
  }
  return error?.message || 'Не удалось сохранить изменения профиля.';
}

async function saveProfile(form) {
  const fullName = String(new FormData(form).get('fullName') || '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 2) return notify('Укажи ФИО полностью.', 'error');
  setBusy(true);
  try {
    const { error: profileError } = await supabase.from('profiles')
      .update({ full_name: fullName, patronymic: '', updated_at: new Date().toISOString() })
      .eq('id', state.user.id);
    if (profileError) throw profileError;
    const { error: membersError } = await supabase.from('group_members')
      .update({ display_name: fullName })
      .eq('user_id', state.user.id);
    if (membersError) throw membersError;
    const { error: authError } = await supabase.auth.updateUser({ data: { full_name: fullName } });
    if (authError) throw authError;
    state.profile = { ...state.profile, fullName, patronymic: '' };
    state.groupMembers = state.groupMembers.map(member =>
      member.id === state.user.id ? { ...member, displayName: fullName } : member
    );
    notify('ФИО обновлено во всех твоих группах.', 'success');
    renderWorkspace();
  } catch (error) {
    notify(profilePermissionMessage(error), 'error');
  } finally { setBusy(false); }
}

async function saveUsername(form) {
  const username = normalizeUsername(new FormData(form).get('username'));
  const currentPassword = String(new FormData(form).get('currentPassword') || '');
  if (!validUsername(username)) return notify('Логин: 3–24 символа, латинские буквы, цифры, точка, дефис или подчёркивание.', 'error');
  if (username === normalizeUsername(state.profile?.username)) return notify('Это уже твой текущий логин.');
  if (!currentPassword) return notify('Введи текущий пароль для подтверждения.', 'error');
  setBusy(true);
  try {
    await reauthenticateCurrentUser(currentPassword);
    const { error } = await supabase.rpc('change_my_username', { p_username: username });
    if (error) {
      if (error.code === '23505') throw new Error('Этот логин уже занят другим аккаунтом. Выбери другой.');
      throw error;
    }
    const { error: metadataError } = await supabase.auth.updateUser({ data: { username } });
    if (metadataError) throw metadataError;
    state.profile = { ...state.profile, username };
    notify('Логин изменён. Теперь входи с @' + username + ' и прежним паролем.', 'success');
    renderWorkspace();
  } catch (error) {
    notify(profilePermissionMessage(error), 'error');
  } finally { setBusy(false); }
}

async function savePassword(form) {
  const data = new FormData(form);
  const currentPassword = String(data.get('currentPassword') || '');
  const newPassword = String(data.get('newPassword') || '');
  const confirmPassword = String(data.get('confirmPassword') || '');

  if (newPassword.length < 8) return notify('Новый пароль должен содержать не менее 8 символов.', 'error');
  if (newPassword !== confirmPassword) return notify('Новые пароли не совпадают.', 'error');
  if (newPassword === currentPassword) return notify('Новый пароль должен отличаться от текущего.', 'error');

  setBusy(true);
  try {
    await reauthenticateCurrentUser(currentPassword);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    form.reset();
    notify('Пароль успешно изменён.', 'success');
  } catch (error) {
    notify(profilePermissionMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function createGroup(form) {
  const name = String(new FormData(form).get('name') || '').trim();
  if (!name) return notify('Укажи название группы.', 'error');
  setBusy(true);
  const groupId = crypto.randomUUID();
  const inviteCode = makeInviteCode();
  try {
    const { error: groupError } = await supabase.from('study_groups').insert({
      id: groupId, name, created_by: state.user.id, data: { studyCycleStart: mondayOf(new Date()) }
    });
    if (groupError) throw groupError;
    const { error: memberError } = await supabase.from('group_members').insert({
      group_id: groupId, user_id: state.user.id, role: 'leader', display_name: displayFullName(state.profile)
    });
    if (memberError) throw memberError;
    const { error: inviteError } = await supabase.from('invite_codes').insert({
      code: inviteCode, group_id: groupId, created_by: state.user.id, data: { groupName: name }
    });
    if (inviteError) throw inviteError;
    await loadMemberships();
    await selectGroup(groupId);
  } catch (error) {
    console.error('STUDIUM group creation failed', error);
    notify(error.message || 'Не удалось создать группу.', 'error');
  } finally { setBusy(false); }
}

async function joinGroup(form) {
  const code = String(new FormData(form).get('code') || '').trim().toUpperCase();
  setBusy(true);
  try {
    const { data: groupId, error } = await supabase.rpc('join_group_with_invite', {
      p_code: code, p_display_name: displayFullName(state.profile)
    });
    if (error) throw error;
    if (!groupId) throw new Error('Код приглашения не найден.');
    await loadMemberships();
    await selectGroup(groupId);
  } catch (error) {
    notify(error.message || 'Не удалось вступить в группу.', 'error');
  } finally { setBusy(false); }
}

async function submitTask(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const lesson = state.lessons.find(item => item.id === values.lessonId) ||
    state.lessons.find(item => item.id === state.selectedScheduleLessonId);
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
    description: '',
    attachmentUrl: String(values.attachmentUrl || '').trim(),
    attachments: []
  };
  if (!payload.title) {
    notify('Укажи название домашнего задания.', 'error');
    return;
  }
  let attachmentUrl = '';
  if (payload.attachmentUrl) {
    try {
      const parsed = new URL(payload.attachmentUrl);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
      attachmentUrl = parsed.href;
    } catch { notify('Укажи корректную ссылку с https:// или http://.', 'error'); return; }
  }
  const files = Array.from(form.querySelector('[name="attachments"]')?.files || []);
  if (files.length > 10) return notify('Можно прикрепить не более 10 файлов.', 'error');
  if (files.some(file => file.size > 20 * 1024 * 1024)) return notify('Размер каждого файла не должен превышать 20 МБ.', 'error');
  setBusy(true);
  const uploadedPaths = [];
  try {
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = state.group.id + '/homework/' + fileId + '/' + safeName;
      const { error } = await supabase.storage.from('group-materials').upload(storagePath, file, {
        contentType: file.type || 'application/octet-stream', upsert: false
      });
      if (error) throw error;
      uploadedPaths.push(storagePath);
      payload.attachments.push({ name: file.name, size: file.size, contentType: file.type || 'application/octet-stream', storagePath });
    }
    payload.attachmentUrl = attachmentUrl;
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
    form.reset();
    state.selectedScheduleLessonId = lesson.id;
    // Live Supabase updates publish the new task or proposal to all open clients.
    root.querySelector('#homework-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (uploadedPaths.length) await supabase.storage.from('group-materials').remove(uploadedPaths).catch(() => {});
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
          description: '',
          attachments: suggestion.attachments || [],
          attachmentUrl: suggestion.attachmentUrl || '',
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
    // The task and suggestion listeners update the open pages automatically.
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
  const card = input.closest('.task-card');
  setBusy(true);
  try {
    await setDoc(progressRef, {
      taskId,
      userId: state.user.uid,
      completed: input.checked,
      updatedAt: serverTimestamp()
    }, { merge: true });
    state.progress.set(taskId, input.checked);
    if (state.tab === 'deadlines') {
      renderWorkspace();
    } else {
      card?.classList.toggle('done', input.checked);
    }
    notify(input.checked ? 'Личный прогресс сохранён.' : 'Личный регресс сохранён.', 'success');
  } catch (error) {
    input.checked = Boolean(current);
    if (state.tab === 'deadlines') {
      renderWorkspace();
    } else {
      card?.classList.toggle('done', Boolean(current));
    }
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
      lessonType: values.lessonType === 'seminar' ? 'seminar' : 'lecture',
      weekday,
      weekNumber,
      startsAt: startPeriod.start,
      endsAt: endPeriod.end,
      periodCount,
      room: String(values.room || '').trim(),
      description: '',
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

    // Delete records in small sequential batches through the Supabase data adapter.
    for (let offset = 0; offset < refs.length; offset += 450) {
      const batch = writeBatch(db);
      refs.slice(offset, offset + 450).forEach(ref => batch.delete(ref));
      await batch.commit();
    }

    if (state.selectedScheduleLessonId === lessonId) state.selectedScheduleLessonId = null;
    notify('Пара и связанные отметки удалены.', 'success');
    await loadWorkspace();
    renderWorkspace();
  } catch (error) {
    console.error('STUDIUM delete lesson failed:', error);
    notify(error.message || 'Не удалось удалить пару. Проверь RLS-политики Supabase.', 'error');
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  root.addEventListener('click', async event => {
    const button = event.target.closest('button,[data-schedule-lesson]');
    if (!button) return;
    if (state.busy && !button.dataset.tab && button.dataset.action !== 'menu') return;
    if (button.dataset.mode) return renderAuth(button.dataset.mode);
    if (button.dataset.themeChoice) { applyTheme(button.dataset.themeChoice); renderWorkspace(); return; }
    if (button.dataset.tab) { state.tab = button.dataset.tab; return renderWorkspace(); }
    if (button.dataset.action === 'logout') return doSignOut();
    if (button.dataset.action === 'menu') { document.querySelector('.sidebar')?.classList.toggle('open'); return; }

    if (button.dataset.action === 'open-task-attachment') {
      const task = state.tasks.find(item => item.id === button.dataset.taskId);
      const file = task?.attachments?.[Number(button.dataset.attachmentIndex)];
      if (!file?.storagePath) return notify('Файл не найден.', 'error');
      const { data, error } = await supabase.storage.from('group-materials').createSignedUrl(file.storagePath, 60);
      if (error) return notify(error.message || 'Не удалось открыть файл.', 'error');
      window.open(data.signedUrl, '_blank', 'noopener');
      return;
    }

    if (button.dataset.action === 'open-lesson-homework') {
      state.selectedScheduleLessonId = button.dataset.id;
      renderWorkspace();
      root.querySelector('#homework-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

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

    if (button.dataset.deadlineDate) {
      state.selectedDeadlineDate = button.dataset.deadlineDate;
      return renderWorkspace();
    }
    if (button.dataset.action === 'deadline-month') {
      const [year, month] = state.deadlineMonth.split('-').map(Number);
      const nextMonth = new Date(year, month - 1 + Number(button.dataset.offset || 0), 1, 12);
      state.deadlineMonth = [nextMonth.getFullYear(), String(nextMonth.getMonth() + 1).padStart(2, '0')].join('-');
      state.selectedDeadlineDate = [state.deadlineMonth, '01'].join('-');
      return renderWorkspace();
    }
    if (button.dataset.action === 'deadline-today') {
      state.deadlineMonth = today().slice(0, 7);
      state.selectedDeadlineDate = today();
      return renderWorkspace();
    }

    if (button.dataset.action === 'delete-task') return deleteTask(button.dataset.id);
    if (button.dataset.action === 'download-material') return openGroupMaterial(button.dataset.id);
    if (button.dataset.action === 'delete-material') return deleteGroupMaterial(button.dataset.id);
    if (button.dataset.action === 'export-attendance-report') {
      const month = root.querySelector('#attendance-report-month')?.value || '';
      return exportAttendanceReport(month);
    }

    if (button.dataset.attendanceLesson) {
      state.selectedAttendanceLessonId = button.dataset.attendanceLesson;
      const selectedLesson = state.lessons.find(item => item.id === state.selectedAttendanceLessonId);
      const parts = selectedLesson ? attendanceParts(selectedLesson) : [];
      state.selectedAttendancePartKey = parts.length > 1 ? parts[0].partKey : null;
      renderWorkspace();
      root.querySelector('.attendance-register')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (button.dataset.attendancePart) {
      state.selectedAttendanceLessonId = button.dataset.lesson;
      state.selectedAttendancePartKey = button.dataset.attendancePart;
      return renderWorkspace();
    }
    if (button.dataset.attendanceAll) return saveAttendanceForAll(button.dataset.attendanceAll);
    if (button.dataset.officialStatus) {
      const partKey = button.dataset.partKey || null;
      const current = attendanceItemForPart(
        state.attendanceRecords,
        button.dataset.lesson,
        button.dataset.student,
        partKey,
        'studentId'
      );
      const hasExactPartRecord = state.attendanceRecords.some(item =>
        item.studentId === button.dataset.student &&
        item.lessonId === button.dataset.lesson &&
        item.lessonDate === state.attendanceDate &&
        (partKey ? item.partKey === partKey : !item.partKey)
      );
      const status = current?.status === button.dataset.officialStatus
        ? (partKey && !hasExactPartRecord ? 'unmarked' : '')
        : button.dataset.officialStatus;
      return saveOfficialAttendance(button.dataset.student, button.dataset.lesson, status, partKey);
    }
    if (button.dataset.action === 'mark-all-present') return markAllPresent(button.dataset.lesson, button.dataset.partKey || null);
    if (button.dataset.action === 'excuse-all-missed') return excuseMissedStudents(button.dataset.lesson, null, button.dataset.partKey || null);
    if (button.dataset.attendance) return saveAttendance(button.dataset.lesson, button.dataset.attendance, button.dataset.partKey || null);

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
    if (state.busy) return;
    if (form.id === 'auth-form') return submitAuth(form);
    if (form.id === 'profile-form') return saveProfile(form);
    if (form.id === 'username-form') return saveUsername(form);
    if (form.id === 'password-form') return savePassword(form);
    if (form.id === 'create-group') return createGroup(form);
    if (form.id === 'join-group') return joinGroup(form);
    if (form.id === 'task-form') return submitTask(form);
    if (form.id === 'lesson-form') return submitLesson(form);
    if (form.id === 'cycle-form') return saveCycle(form);
    if (form.id === 'material-upload-form') return uploadGroupMaterial(form);
    if (form.id === 'material-link-form') return addGroupMaterialLink(form);
  });

  root.addEventListener('change', async event => {
    if (state.busy) return;
    if (event.target.matches('[data-progress]')) return updateProgress(event.target);
    if (event.target.id === 'attendance-date' && event.target.value) {
      state.attendanceDate = event.target.value;
      state.selectedAttendanceLessonId = null;
      state.selectedAttendancePartKey = null;
      try {
        await loadWorkspace();
        renderWorkspace();
        subscribeToLiveHomework();
      } catch (error) { notify(error.message, 'error'); }
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
  stopLiveHomeworkUpdates();
  try {
    await signOutFromSupabase();
    state.user = null;
    state.group = null;
    state.activeMembership = null;
    renderAuth();
  } catch (error) {
    notify(error.message || 'Не удалось выйти.', 'error');
  } finally { setBusy(false); }
}

function start() {
  applyTheme(state.theme);
  bindEvents();
  if (!supabaseConfigured) return renderSetup();
  supabase.auth.onAuthStateChange((_event, session) => {
    queueMicrotask(async () => {
      try { await boot(session?.user ?? null); }
      catch (error) {
        console.error(error);
        renderAuth('login', 'Не удалось загрузить данные: ' + (error.message || 'неизвестная ошибка'));
      }
    });
  });
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) throw error;
    if (!data.session) renderAuth();
  }).catch(error => renderAuth('login', error.message));
}

start();
