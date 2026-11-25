import { createClient } from '@supabase/supabase-js';
import './style.css';

const root = document.querySelector('#app');
const url = import.meta.env.VITE_SUPABASE_URL || '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const ready = /^https:\/\/.+\.supabase\.co$/.test(url) && key.length > 20;
const db = ready ? createClient(url, key) : null;
const today = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateText = v => v ? new Date(v + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Без срока';
const state = {
  user: null, profile: null, memberships: [], group: null, role: null,
  tab: 'overview', tasks: [], suggestions: [], lessons: [],
  progress: new Map(), attendance: [], attendanceDate: today(), busy: false
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
  root.querySelectorAll('button').forEach(b => { b.disabled = flag; });
}
function frame(html) {
  root.innerHTML = html + '<div id="toast" role="status" aria-live="polite"></div>';
}
function renderSetup() {
  frame('<main class="setup"><div class="monogram">S</div><p class="eyebrow">НАСТРОЙКА</p><h1>STUDIUM</h1><p class="muted">Подключи Supabase, чтобы запустить учебное пространство.</p><article class="panel"><h2>Добавь ключи проекта</h2><ol><li>Создай проект в <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Supabase Dashboard</a>.</li><li>Скопируй Project URL и publishable/anon key.</li><li>Создай локальный файл <code>.env</code> по образцу <code>.env.example</code>.</li><li>Выполни миграцию <code>supabase/migrations/001_initial_schema.sql</code> в SQL Editor.</li></ol><p class="notice">Не используй service_role или secret key в браузере.</p></article></main>');
}
function renderAuth(mode = 'login', message = '') {
  const signup = mode === 'signup';
  frame('<main class="auth"><section class="auth-intro"><div class="monogram">S</div><p class="eyebrow">YOUR ACADEMIC SPACE</p><h1>STUDIUM</h1><p>Всё важное для учёбы — в одном пространстве.</p><div class="ornament">— ✦ —</div></section><section class="panel auth-panel"><div class="switch"><button type="button" data-mode="login" class="' + (!signup ? 'active' : '') + '">Войти</button><button type="button" data-mode="signup" class="' + (signup ? 'active' : '') + '">Регистрация</button></div><h2>' + (signup ? 'Создать аккаунт' : 'С возвращением') + '</h2><p class="muted">' + (message ? esc(message) : (signup ? 'Создай аккаунт, чтобы присоединиться к своей группе.' : 'Войди в своё учебное пространство.')) + '</p><form id="auth-form" class="form"><label>Email<input name="email" type="email" autocomplete="email" required placeholder="name@example.com"></label>' + (signup ? '<label>Имя и фамилия<input name="full_name" minlength="2" maxlength="80" autocomplete="name" required placeholder="Александр Иванов"></label>' : '') + '<label>Пароль<input name="password" type="password" minlength="8" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" required placeholder="Не менее 8 символов"></label><button class="btn primary" type="submit">' + (signup ? 'Создать аккаунт' : 'Войти') + '</button></form><p class="foot muted">STUDIUM · учебное пространство твоей группы</p></section></main>');
}
async function submitAuth(form) {
  const data = new FormData(form);
  const email = String(data.get('email') || '').trim();
  const password = String(data.get('password') || '');
  setBusy(true);
  try {
    if (data.has('full_name')) {
      const { data: result, error } = await db.auth.signUp({ email, password, options: { data: { full_name: String(data.get('full_name')).trim() } } });
      if (error) throw error;
      if (!result.session) {
        renderAuth('login', 'Аккаунт создан. Подтверди email из письма, затем войди.');
        return;
      }
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    await boot();
  } catch (e) { notify(e.message || 'Ошибка авторизации', 'error'); }
  finally { setBusy(false); }
}
async function boot() {
  if (!ready) return renderSetup();
  const { data: { session }, error } = await db.auth.getSession();
  if (error) throw error;
  state.user = session?.user || null;
  if (!state.user) return renderAuth();
  const { data: profile, error: pErr } = await db.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
  if (pErr) throw pErr;
  state.profile = profile;
  await loadMemberships();
  if (!state.memberships.length) return renderOnboarding();
  const saved = localStorage.getItem('studium-group');
  const membership = state.memberships.find(x => x.group_id === saved) || state.memberships[0];
  await selectGroup(membership.group_id);
}
async function loadMemberships() {
  const { data, error } = await db.from('group_members')
    .select('group_id, role, joined_at, groups(id,name,invite_code,study_cycle_start)')
    .eq('user_id', state.user.id).order('joined_at', { ascending: true });
  if (error) throw error;
  state.memberships = (data || []).filter(x => x.groups).map(x => ({ group_id: x.group_id, role: x.role, group: x.groups }));
}
function renderOnboarding() {
  frame('<main class="onboard"><header><a class="wordmark" href="#">STUDIUM</a><button class="btn ghost" data-action="logout">Выйти</button></header><section><p class="eyebrow">ДОБРО ПОЖАЛОВАТЬ</p><h1>Твоя учебная<br><em>группа начинается здесь.</em></h1><p class="muted lead">Создай новое пространство или присоединись к группе по коду приглашения.</p><div class="onboard-grid"><form id="create-group" class="panel form"><span class="tile-icon">＋</span><h2>Создать группу</h2><p class="muted">Ты станешь старостой группы.</p><label>Название<input name="name" required minlength="2" maxlength="80" placeholder="Например, ИС-21"></label><button class="btn primary">Создать группу</button></form><form id="join-group" class="panel form"><span class="tile-icon">↗</span><h2>Вступить в группу</h2><p class="muted">Введи код, который отправил староста.</p><label>Код приглашения<input name="code" required maxlength="12" placeholder="A4K8P2QW9T2"></label><button class="btn secondary">Присоединиться</button></form></div></section></main>');
}
async function selectGroup(id) {
  const membership = state.memberships.find(x => x.group_id === id);
  if (!membership) throw new Error('Группа не найдена.');
  state.group = membership.group;
  state.role = membership.role;
  localStorage.setItem('studium-group', id);
  await loadWorkspace();
  renderWorkspace();
}
async function loadWorkspace() {
  const gid = state.group.id;
  const [tasks, suggestions, lessons, progress, attendance] = await Promise.all([
    db.from('tasks').select('*').eq('group_id', gid).order('due_date', { ascending: true, nullsFirst: false }),
    db.from('task_suggestions').select('*').eq('group_id', gid).order('created_at', { ascending: false }),
    db.from('lessons').select('*').eq('group_id', gid).order('weekday').order('starts_at'),
    db.from('student_task_progress').select('task_id,user_id,completed').eq('user_id', state.user.id),
    db.from('attendance_responses').select('*').eq('group_id', gid).eq('lesson_date', state.attendanceDate)
  ]);
  for (const r of [tasks, suggestions, lessons, progress, attendance]) if (r.error) throw r.error;
  state.tasks = tasks.data || [];
  state.suggestions = suggestions.data || [];
  state.lessons = lessons.data || [];
  state.progress = new Map((progress.data || []).map(x => [x.task_id, x.completed]));
  state.attendance = attendance.data || [];
}
function navButton(tab, icon, title) {
  return '<button type="button" class="' + (state.tab === tab ? 'active' : '') + '" data-tab="' + tab + '"><span>' + icon + '</span>' + title + '</button>';
}
function renderWorkspace() {
  const leader = state.role === 'leader';
  const name = state.profile?.full_name || state.user.email || 'Пользователь';
  const tabs = [
    navButton('overview', '⌂', 'Обзор'),
    navButton('tasks', '✓', 'Домашние задания'),
    ...(leader ? [navButton('moderation', '◇', 'Модерация <b>' + state.suggestions.filter(x => x.status === 'pending').length + '</b>')] : []),
    navButton('schedule', '▦', 'Расписание'),
    navButton('attendance', '◷', 'Посещаемость'),
    navButton('library', '▤', 'Материалы'),
    navButton('manage', '⚙', 'Группа')
  ].join('');
  frame('<div class="layout"><aside class="sidebar"><a class="wordmark" href="#">STUDIUM</a><div class="group-box"><small>УЧЕБНАЯ ГРУППА</small><strong>' + esc(state.group.name) + '</strong><span class="role">' + (leader ? 'Староста' : 'Студент') + '</span></div><nav>' + tabs + '</nav><div class="side-user"><div class="avatar">' + esc(name.slice(0,1).toUpperCase()) + '</div><div><strong>' + esc(name) + '</strong><small>' + esc(state.user.email) + '</small></div><button class="btn ghost" data-action="logout">Выйти</button></div></aside><main class="main"><header class="mobile-head"><button class="btn ghost" data-action="menu">☰</button><a class="wordmark" href="#">STUDIUM</a><span class="role">' + (leader ? 'Староста' : 'Студент') + '</span></header><div class="content">' + renderCurrentTab() + '</div></main></div>');
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
  if (state.tab === 'library') return heading('БИБЛИОТЕКА', 'Материалы', 'Методички, ссылки, презентации и лекции.') + '<div class="grid-two"><article class="panel"><h2>Материалы группы</h2><p class="muted">Загрузку файлов и библиотеку подключим следующим этапом.</p></article><article class="panel"><h2>Лекции</h2><p class="muted">Отдельная библиотека лекций будет перенесена из study-journal.</p></article></div>';
  if (state.tab === 'manage') return renderManage();
  return renderOverview();
}
function renderOverview() {
  const pending = state.suggestions.filter(x => x.status === 'pending').length;
  const completed = state.tasks.filter(x => state.progress.get(x.id)).length;
  return heading('STUDIUM / ОБЗОР', 'Добро пожаловать', esc(state.profile?.full_name || 'в твоё учебное пространство'), '<button class="btn primary" data-tab="tasks">Открыть задания →</button>') +
    '<div class="stats"><article><small>Заданий в группе</small><strong>' + state.tasks.length + '</strong></article><article><small>Выполнено тобой</small><strong>' + completed + '</strong></article><article><small>Ближайший дедлайн</small><strong class="date-stat">' + esc(dateText(state.tasks.find(x => x.due_date)?.due_date)) + '</strong></article><article><small>На модерации</small><strong>' + (state.role === 'leader' ? pending : '—') + '</strong></article></div>' +
    '<section class="section"><div class="section-title"><h2>Ближайшие задания</h2><button class="text-btn" data-tab="tasks">Все задания →</button></div>' + taskCards(state.tasks.slice(0,3)) + '</section>';
}
function taskCards(items) {
  if (!items.length) return empty('Пока нет заданий', 'Добавь задание или предложи его старосте.');
  return '<div class="task-list">' + items.map(task => {
    const done = state.progress.get(task.id) === true;
    return '<article class="task-card ' + (done ? 'done' : '') + '"><div class="task-copy"><small>' + esc(task.subject || 'Без предмета') + '</small><h3>' + esc(task.title) + '</h3><p>' + esc(task.description || '') + '</p><div class="meta"><span>Срок: ' + esc(dateText(task.due_date)) + '</span></div></div><label class="check"><input type="checkbox" data-progress="' + task.id + '" ' + (done ? 'checked' : '') + '> Выполнено</label></article>';
  }).join('') + '</div>';
}
function taskForm() {
  return '<section class="panel compose"><div><p class="eyebrow">НОВОЕ ЗАДАНИЕ</p><h2>' + (state.role === 'leader' ? 'Опубликовать ДЗ' : 'Предложить ДЗ') + '</h2><p class="muted">' + (state.role === 'leader' ? 'Задание сразу появится у всей группы.' : 'Староста проверит описание и опубликует задание для группы.') + '</p></div><form id="task-form" class="form"><div class="two"><label>Предмет<input name="subject" maxlength="120" placeholder="Например, Анатомия"></label><label>Дата пары<input name="lesson_date" type="date"></label></div><label>Название задания<input name="title" required maxlength="180" placeholder="Что нужно сделать?"></label><label>Описание<textarea name="description" rows="3" placeholder="Дополнительные требования, страницы, вопросы…"></textarea></label><label>Срок выполнения<input name="due_date" type="date"></label><button class="btn primary">' + (state.role === 'leader' ? 'Опубликовать' : 'Отправить старосте') + '</button></form></section>';
}
function renderTasks() {
  return heading('УЧЕБНЫЙ ПРОЦЕСС', 'Домашние задания', 'Общий список группы и твой персональный прогресс.') + taskForm() + taskCards(state.tasks);
}
function renderModeration() {
  const pending = state.suggestions.filter(x => x.status === 'pending');
  const done = state.suggestions.filter(x => x.status !== 'pending');
  return heading('ПАНЕЛЬ СТАРОСТЫ', 'Модерация ДЗ', 'Проверь предложения студентов перед публикацией.') +
    (pending.length ? '<div class="moderation">' + pending.map(x => '<article class="panel moderation-card"><div class="meta"><span>' + esc(x.subject || 'Без предмета') + '</span><span>Предложено ' + esc(dateText(x.created_at?.slice(0,10))) + '</span></div><h2>' + esc(x.title) + '</h2><p>' + esc(x.description || '') + '</p><div class="meta"><span>Пара: ' + esc(dateText(x.lesson_date)) + '</span><span>Срок: ' + esc(dateText(x.due_date)) + '</span></div><div class="actions"><button class="btn primary" data-review="approve" data-id="' + x.id + '">Одобрить и опубликовать</button><button class="btn danger" data-review="reject" data-id="' + x.id + '">Отклонить</button></div></article>').join('') + '</div>' : empty('Новых предложений нет', 'Когда студент предложит домашнее задание, оно появится здесь.')) +
    (done.length ? '<section class="section"><h2>Рассмотренные предложения</h2><div class="history">' + done.slice(0,8).map(x => '<div><span>' + esc(x.title) + '</span><span class="status ' + x.status + '">' + (x.status === 'approved' ? 'Опубликовано' : 'Отклонено') + '</span></div>').join('') + '</div></section>' : '');
}
function renderSchedule() {
  const days = ['','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const add = state.role === 'leader' ? '<button class="btn primary" data-action="show-lesson">＋ Добавить пару</button>' : '';
  const rows = state.lessons.map(x => '<article class="lesson"><time>' + esc(String(x.starts_at).slice(0,5)) + (x.ends_at ? '–' + esc(String(x.ends_at).slice(0,5)) : '') + '</time><div><small>' + days[x.weekday] + ' · ' + (x.week_number === 2 ? 'II неделя' : 'I неделя') + '</small><strong>' + esc(x.subject) + '</strong><p>' + esc(x.room || 'Аудитория не указана') + '</p></div></article>').join('');
  return heading('РАСПИСАНИЕ', 'Занятия группы', 'Расписание на чередующиеся учебные недели.', add) +
    (state.role === 'leader' ? '<section class="panel inline-form hidden" id="lesson-editor"><form id="lesson-form" class="form"><h2>Новая пара</h2><label>Предмет<input name="subject" required maxlength="120"></label><div class="two"><label>День<select name="weekday"><option value="1">Понедельник</option><option value="2">Вторник</option><option value="3">Среда</option><option value="4">Четверг</option><option value="5">Пятница</option><option value="6">Суббота</option></select></label><label>Неделя<select name="week_number"><option value="1">Первая</option><option value="2">Вторая</option></select></label></div><div class="two"><label>Начало<input name="starts_at" type="time" value="08:30" required></label><label>Конец<input name="ends_at" type="time" value="10:05"></label></div><label>Аудитория<input name="room" maxlength="40"></label><button class="btn primary">Сохранить</button><button type="button" class="btn ghost" data-action="hide-lesson">Отмена</button></form></section>' : '') +
    (rows ? '<div class="lesson-list">' + rows + '</div>' : empty('Расписание пока пустое', 'Староста сможет добавить пары в этом разделе.'));
}
function lessonWeekFor(date) {
  const [sy,sm,sd] = (state.group.study_cycle_start || today()).split('-').map(Number);
  const [y,m,d] = date.split('-').map(Number);
  const a = Date.UTC(sy,sm-1,sd), b = Date.UTC(y,m-1,d);
  const n = Math.floor((b-a)/604800000);
  return ((n % 2) + 2) % 2 + 1;
}
function renderAttendance() {
  const date = state.attendanceDate;
  const [y,m,d] = date.split('-').map(Number);
  const weekday = ((new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7)+1;
  const week = lessonWeekFor(date);
  const lessons = state.lessons.filter(x => x.weekday === weekday && x.week_number === week);
  const responses = new Map(state.attendance.map(x => [x.lesson_id, x.response]));
  return heading('ПОСЕЩАЕМОСТЬ', 'Предварительная явка', 'Отметь, планируешь ли ты быть на паре. Это не официальная отметка посещения.') +
    '<div class="date-picker"><label>Дата<input type="date" id="attendance-date" value="' + date + '"></label><span>' + (week === 1 ? 'Первая' : 'Вторая') + ' учебная неделя</span></div>' +
    (lessons.length ? '<div class="attendance">' + lessons.map(x => '<article class="lesson attendance-item"><div><small>' + esc(x.starts_at.slice(0,5)) + (x.ends_at ? '–' + esc(x.ends_at.slice(0,5)) : '') + '</small><strong>' + esc(x.subject) + '</strong><p>' + esc(x.room || 'Аудитория не указана') + '</p></div><div class="actions"><button class="btn ' + (responses.get(x.id) === 'will_attend' ? 'primary' : 'secondary') + '" data-attendance="will_attend" data-lesson="' + x.id + '">Буду</button><button class="btn ' + (responses.get(x.id) === 'will_miss' ? 'primary' : 'secondary') + '" data-attendance="will_miss" data-lesson="' + x.id + '">Не буду</button></div></article>').join('') + '</div>' : empty('На эту дату пар нет', 'Выбери другую дату или проверь расписание группы.')) +
    '<p class="muted small">Староста видит предварительные ответы участников. Фактическая посещаемость хранится отдельно.</p>';
}
function renderManage() {
  const select = state.memberships.length > 1 ? '<label class="field-label">Переключить группу<select id="group-switch">' + state.memberships.map(x => '<option value="' + x.group_id + '" ' + (x.group_id === state.group.id ? 'selected' : '') + '>' + esc(x.group.name) + '</option>').join('') + '</select></label>' : '';
  return heading('ПРОСТРАНСТВО ГРУППЫ', 'Управление', 'Участники и настройки учебного пространства.') +
    '<section class="panel invite"><div><small>КОД ПРИГЛАШЕНИЯ</small><h2>' + esc(state.group.invite_code) + '</h2><p class="muted">Отправь этот код одногруппникам.</p></div><button class="btn secondary" data-action="copy-code">Скопировать</button></section>' +
    '<section class="panel"><p>Твоя роль: <strong>' + (state.role === 'leader' ? 'Староста' : 'Студент') + '</strong></p>' + select + (state.role === 'leader' ? '<form id="cycle-form" class="form"><label>Начало первой учебной недели (понедельник)<input name="study_cycle_start" type="date" value="' + esc(state.group.study_cycle_start || '') + '" required></label><button class="btn secondary">Сохранить учебный цикл</button></form>' : '') + '</section>';
}
function bindEvents() {
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.mode) return renderAuth(button.dataset.mode);
    if (button.dataset.tab) { state.tab = button.dataset.tab; return renderWorkspace(); }
    if (button.dataset.action === 'logout') return signOut();
    if (button.dataset.action === 'menu') { document.querySelector('.sidebar')?.classList.toggle('open'); return; }
    if (button.dataset.action === 'show-lesson') { document.querySelector('#lesson-editor')?.classList.remove('hidden'); return; }
    if (button.dataset.action === 'hide-lesson') { document.querySelector('#lesson-editor')?.classList.add('hidden'); return; }
    if (button.dataset.action === 'copy-code') {
      try { await navigator.clipboard.writeText(state.group.invite_code); notify('Код скопирован.', 'success'); }
      catch { notify('Код приглашения: ' + state.group.invite_code); }
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
      try { await loadWorkspace(); renderWorkspace(); } catch (e) { notify(e.message, 'error'); }
    }
    if (event.target.id === 'group-switch') {
      try { await selectGroup(event.target.value); } catch (e) { notify(e.message, 'error'); }
    }
  });
}
async function createGroup(form) {
  setBusy(true);
  try {
    const name = new FormData(form).get('name');
    const { data, error } = await db.rpc('create_group', { p_name: String(name).trim() });
    if (error) throw error;
    await loadMemberships(); await selectGroup(data);
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function joinGroup(form) {
  setBusy(true);
  try {
    const code = String(new FormData(form).get('code') || '').trim().toUpperCase();
    const { data, error } = await db.rpc('join_group', { p_invite_code: code });
    if (error) throw error;
    await loadMemberships(); await selectGroup(data);
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function submitTask(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    group_id: state.group.id,
    subject: String(values.subject || '').trim(),
    title: String(values.title || '').trim(),
    description: String(values.description || '').trim(),
    lesson_date: values.lesson_date || null,
    due_date: values.due_date || null
  };
  setBusy(true);
  try {
    const table = state.role === 'leader' ? 'tasks' : 'task_suggestions';
    const owner = state.role === 'leader' ? 'created_by' : 'submitted_by';
    const { error } = await db.from(table).insert({ ...payload, [owner]: state.user.id });
    if (error) throw error;
    notify(state.role === 'leader' ? 'Задание опубликовано.' : 'Предложение отправлено старосте.', 'success');
    await loadWorkspace(); renderWorkspace();
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function reviewSuggestion(id, approve) {
  setBusy(true);
  try {
    const { error } = await db.rpc('review_task_suggestion', { p_suggestion_id: id, p_approve: approve });
    if (error) throw error;
    notify(approve ? 'Задание опубликовано для группы.' : 'Предложение отклонено.', 'success');
    await loadWorkspace(); renderWorkspace();
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function updateProgress(input) {
  setBusy(true);
  try {
    const { error } = await db.from('student_task_progress').upsert({
      task_id: input.dataset.progress, user_id: state.user.id,
      completed: input.checked, updated_at: new Date().toISOString()
    }, { onConflict: 'task_id,user_id' });
    if (error) throw error;
    state.progress.set(input.dataset.progress, input.checked);
    notify('Личный прогресс сохранён.', 'success');
  } catch (e) { notify(e.message, 'error'); input.checked = !input.checked; }
  finally { setBusy(false); }
}
async function submitLesson(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  setBusy(true);
  try {
    const { error } = await db.from('lessons').insert({
      group_id: state.group.id, subject: String(v.subject).trim(),
      weekday: Number(v.weekday), week_number: Number(v.week_number),
      starts_at: v.starts_at, ends_at: v.ends_at || null,
      room: String(v.room || '').trim(), created_by: state.user.id
    });
    if (error) throw error;
    notify('Пара добавлена.', 'success'); await loadWorkspace(); renderWorkspace();
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function saveAttendance(lessonId, response) {
  const row = {
    group_id: state.group.id, lesson_id: lessonId, user_id: state.user.id,
    lesson_date: state.attendanceDate, response
  };
  setBusy(true);
  try {
    const { error } = await db.from('attendance_responses').upsert(row, { onConflict: 'lesson_id,lesson_date,user_id' });
    if (error) throw error;
    notify('Предварительный ответ сохранён.', 'success');
    await loadWorkspace(); renderWorkspace();
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function saveCycle(form) {
  const value = new FormData(form).get('study_cycle_start');
  if (!value) return;
  const date = new Date(value + 'T00:00:00');
  if (date.getDay() !== 1) return notify('Выбери понедельник.', 'error');
  setBusy(true);
  try {
    const { error } = await db.from('groups').update({ study_cycle_start: value }).eq('id', state.group.id);
    if (error) throw error;
    state.group.study_cycle_start = value;
    notify('Учебный цикл сохранён.', 'success');
  } catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function signOut() {
  setBusy(true);
  try { await db.auth.signOut(); state.user = null; state.group = null; renderAuth(); }
  catch (e) { notify(e.message, 'error'); }
  finally { setBusy(false); }
}
async function start() {
  bindEvents();
  if (!ready) return renderSetup();
  try { await boot(); }
  catch (e) { console.error(e); renderAuth('login', 'Не удалось загрузить данные: ' + e.message); }
  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { state.user = null; renderAuth(); }
    if (event === 'SIGNED_IN' && session?.user && session.user.id !== state.user?.id) {
      state.user = session.user;
      queueMicrotask(() => boot().catch(e => notify(e.message, 'error')));
    }
  });
}
start();
