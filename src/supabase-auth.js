import { supabase, supabaseConfigured } from './supabase.js';

const normalizeUsername = value => String(value ?? '').trim().toLowerCase();
const validUsername = value => /^[a-z0-9][a-z0-9._-]{2,23}$/.test(value);

// STUDIUM accounts use a private, deterministic email alias so the existing
// username-based sign-in screen can be retained. Disable email confirmations
// in Supabase Auth before enabling this flow for production.
const authEmailForUsername = username => `${normalizeUsername(username)}@studium.invalid`;

function requireSupabase() {
  if (!supabaseConfigured || !supabase) {
    throw new Error('Supabase не настроен. Проверь VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY.');
  }
}

export async function signUpWithUsername({ username, password, fullName }) {
  requireSupabase();
  const normalized = normalizeUsername(username);
  if (!validUsername(normalized)) throw new Error('Логин должен содержать 3–24 символа: латинские буквы, цифры, точку, дефис или подчёркивание.');
  if (String(password ?? '').length < 8) throw new Error('Пароль должен содержать не менее 8 символов.');
  if (String(fullName ?? '').trim().length < 2) throw new Error('Укажи ФИО.');

  const { data, error } = await supabase.auth.signUp({
    email: authEmailForUsername(normalized),
    password,
    options: { data: { username: normalized, full_name: String(fullName).trim() } }
  });
  if (error) throw error;
  if (!data.user) throw new Error('Supabase не вернул созданного пользователя.');
  if (!data.session) {
    throw new Error('Аккаунт создан, но Supabase ожидает подтверждение почты. Отключи Confirm email в настройках Auth или настрой реальную почту для регистрации.');
  }

  const { error: profileError } = await supabase.from('profiles').upsert({
    id: data.user.id,
    username: normalized,
    full_name: String(fullName).trim(),
    patronymic: ''
  }, { onConflict: 'id' });
  if (profileError) throw profileError;
  const { error: aliasError } = await supabase.from('username_logins').insert({
    username: normalized, auth_email: data.user.email, user_id: data.user.id
  });
  if (aliasError) throw aliasError;
  return data;
}

export async function signInWithUsername({ username, password }) {
  requireSupabase();
  const normalized = normalizeUsername(username);
  if (!validUsername(normalized)) throw new Error('Проверь логин.');
  const { data: resolvedEmail, error: lookupError } = await supabase.rpc('resolve_login_email', { p_username: normalized });
  if (lookupError) throw lookupError;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: resolvedEmail || authEmailForUsername(normalized),
    password
  });
  if (error) throw error;
  return data;
}

export async function signOutFromSupabase() {
  requireSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentSupabaseProfile(userId) {
  requireSupabase();
  const { data, error } = await supabase.from('profiles')
    .select('id, username, full_name, patronymic')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function onSupabaseAuthStateChange(callback) {
  requireSupabase();
  return supabase.auth.onAuthStateChange((event, session) => callback(event, session?.user ?? null));
}
