# STUDIUM

STUDIUM — отдельная платформа для учебных групп. Проект создаётся с нуля на Vite, Vanilla JavaScript и Supabase. 

## Возможности текущего MVP

- Регистрация и вход по email/паролю через Supabase Auth.
- Профиль пользователя.
- Создание нескольких учебных групп и вступление по коду приглашения.
- Роли `leader` (староста) и `student`.
- Публикация домашних заданий старостой.
- Предложения домашних заданий студентами и модерация старостой.
- Личные отметки о выполнении заданий.
- Базовое расписание группы.
- Предварительные ответы студентов о посещении пары.
- Отдельная таблица официальной посещаемости, которую заполняет староста.

## Стек

- Vite + Vanilla JavaScript
- Supabase Auth
- Supabase PostgreSQL
- Row Level Security (RLS)
- PWA shell cache через Service Worker

## Локальный запуск

Требуется Node.js 20 или новее.

```bash
npm install
cp .env.example .env
```

Заполни `.env`:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

Запусти сервер разработки:

```bash
npm run dev
```

## Настройка Supabase

1. Создай проект в [Supabase Dashboard](https://supabase.com/dashboard).
2. Открой SQL Editor и выполни целиком `supabase/migrations/001_initial_schema.sql`.
3. В Project Settings → API скопируй Project URL и publishable key (или legacy anon key) в локальный файл `.env`.
4. В Authentication → URL Configuration укажи локальный URL разработки и URL будущего сайта в Site URL / Redirect URLs.
5. В Authentication → Providers проверь, что включён Email provider.

**Никогда не помещай `service_role` или secret key в браузерный код или GitHub.** Клиенту разрешён только publishable/anon key. Все права должны обеспечиваться RLS.

## Начальная проверка

1. Зарегистрируй первый аккаунт.
2. Создай группу — создатель автоматически получает роль старосты.
3. Скопируй код приглашения в разделе управления группой.
4. Зарегистрируй второй тестовый аккаунт в другом браузере или режиме инкогнито.
5. Войди вторым аккаунтом и присоединись по коду.
6. От имени студента предложи домашнее задание.
7. Вернись в аккаунт старосты, открой модерацию и одобри предложение.
8. Убедись, что опубликованное задание появилось у студента, а отметка выполнения меняется только у текущего пользователя.

## Модель доступа

- Студент читает опубликованные задания своей группы, создаёт только собственные предложения и изменяет только собственный прогресс.
- Староста читает предложения своей группы и одобряет или отклоняет их через RPC `review_task_suggestion`.
- Староста может публиковать задания и управлять расписанием.
- Предварительные ответы о посещаемости хранятся в `attendance_responses`.
- Официальные отметки хранятся отдельно в `attendance_records` и доступны старосте.
- Вступление в группу выполняется через RPC, а не прямой вставкой членства из браузера.

## Структура

```text
studium/
├── .github/workflows/deploy.yml
├── public/
│   ├── manifest.webmanifest
│   ├── studium-mark.svg
│   └── sw.js
├── src/
│   ├── main.js
│   └── style.css
├── supabase/migrations/001_initial_schema.sql
├── .env.example
├── .gitignore
├── index.html
├── package.json
└── vite.config.js
```

## Что ещё предстоит

Текущая версия — основа продукта, а не законченный production-релиз. Следующие этапы:

1. Протестировать Auth, группы, роли и RLS на двух аккаунтах в реальном Supabase.
2. Довести модерацию: редактирование старостой перед публикацией, комментарий при отклонении и журнал действий.
3. Добавить Storage-вложения для предложений, заданий, материалов и лекций.
4. Перенести полноценное расписание из `study-journal`.
5. Перенести сбор ответов и журнал посещаемости из `yavka`, добавить статистику и экспорт Excel.
6. Добавить календарь, уведомления, офлайн-стратегию и сборки Android/Windows.

## Деплой

GitHub Actions workflow в `.github/workflows/deploy.yml` собирает Vite-приложение и публикует его в GitHub Pages после включения Pages в настройках репозитория (Source: GitHub Actions). Для сборки в Actions добавь repository variable `VITE_SUPABASE_URL` и repository variable `VITE_SUPABASE_ANON_KEY`. Не добавляй secret/service_role key в клиентскую сборку.
