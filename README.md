# STUDIUM

STUDIUM — платформа для учебных групп. Клиентская часть построена на Vite и Vanilla JavaScript; backend полностью работает на Supabase.

## Возможности

- Регистрация и вход по логину и паролю (без ввода email пользователем).
- Профили пользователей.
- Создание учебных групп, роли старосты и студента, вступление по коду приглашения.
- Домашние задания, предложения студентов и модерация старостой.
- Личные отметки о выполнении заданий.
- Расписание на две чередующиеся учебные недели.
- Предварительные ответы о посещении и официальный журнал посещаемости.
- Библиотека ссылок и файлов группы.
- Экспорт отчёта по посещаемости.

## Стек

- Vite + Vanilla JavaScript
- Supabase Auth
- Supabase Postgres с Row Level Security
- Supabase Storage (private bucket `group-materials`)
- Supabase JS SDK

## Настройка Supabase

Проект использует Supabase: https://supabase.com/dashboard

1. Открой проект Supabase.
2. В Authentication → Providers / Sign In настроь Email provider и отключи **Confirm email**. Пользователи вводят логин, а приложение формирует внутренний адрес `<login>@studium.invalid`.
3. В SQL Editor последовательно выполни миграции из `supabase/migrations`:
   - `202611260001_initial_schema.sql`
   - `202611260002_secure_group_join_and_policies.sql`
   - `202611260003_student_record_policies.sql`
   - `202611260004_grant_authenticated_data_api.sql`
   - `202611260005_revoke_rls_auto_enable.sql`
   - `202611260006_member_display_name.sql`
4. В Project Settings → API скопируй Project URL и publishable key.
5. Создай локальный `.env` на основе `.env.example` и укажи:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`

Миграции создают таблицы, RLS-политики и приватный Storage bucket `group-materials`. Не используй service_role key в браузере и не добавляй его в GitHub.

## Локальный запуск

Требуется Node.js 20 или новее.

```bash
npm install
cp .env.example .env
npm run dev
```

## GitHub Pages

Workflow `.github/workflows/deploy.yml` собирает и публикует приложение. В Settings → Secrets and variables → Actions → Variables добавь:

| Variable | Значение |
|---|---|
| `VITE_SUPABASE_URL` | Supabase Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable/anon key |

## Данные и безопасность

Supabase — единственный backend проекта. Старые данные не переносятся. Групповые записи хранятся в `group_records` с раздельными коллекциями; членство и роль проверяются через RLS. Файлы хранятся в приватном Supabase Storage и выдаются через короткоживущие signed URLs.
