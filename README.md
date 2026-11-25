# STUDIUM

STUDIUM — отдельная платформа для учебных групп. Проект создаётся с нуля на Vite, Vanilla JavaScript и Firebase.

## Возможности текущего MVP

- Регистрация с одним полем ФИО и логином; вход по логину/паролю без ввода пользователем email. Внутри Firebase логин преобразуется в технический email-идентификатор проекта.
- Профиль пользователя в Cloud Firestore.
- Создание нескольких учебных групп и вступление по коду приглашения.
- Роли leader (староста) и student.
- Публикация домашних заданий старостой с привязкой к паре из расписания и автоматической датой занятия; отдельного срока выполнения нет.
- Предложения домашних заданий студентами с выбором пары из расписания и модерация старостой.
- Личные отметки о выполнении заданий.
- Недельная сетка расписания на две чередующиеся недели с временными слотами, выделением текущего дня, карточками предметов и домашними заданиями; староста может добавлять и удалять пары через отдельную форму.
- Предварительные ответы студентов о посещении пары.
- Отдельная модель официальной посещаемости, которую заполняет староста.

## Стек

- Vite + Vanilla JavaScript
- Firebase Authentication
- Cloud Firestore
- Firestore Security Rules
- Firebase modular Web SDK
- PWA shell cache через Service Worker

## Локальный запуск

Требуется Node.js 20 или новее.

    npm install
    cp .env.example .env

Заполни .env значениями Web App из Firebase Console:

    VITE_FIREBASE_API_KEY=YOUR_FIREBASE_WEB_API_KEY
    VITE_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT_ID.firebaseapp.com
    VITE_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
    VITE_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT_ID.firebasestorage.app
    VITE_FIREBASE_MESSAGING_SENDER_ID=YOUR_MESSAGING_SENDER_ID
    VITE_FIREBASE_APP_ID=YOUR_FIREBASE_APP_ID

Запусти сервер разработки:

    npm run dev

## Создание Firebase-проекта

Для STUDIUM рекомендуется отдельный Firebase project, не тот, который использует старая «Явка». Это отделит пользовательские данные, правила доступа, настройки Authentication и квоты.

1. Открой Firebase Console: https://console.firebase.google.com/ и создай проект STUDIUM.
2. В Project settings → General добавь Web App и скопируй Firebase config в .env.
3. Открой Authentication → Sign-in method и включи Email/Password. Этот провайдер остаётся включённым, хотя в интерфейсе пользователь вводит логин, а не email.
4. Открой Firestore Database и создай базу в Production mode.
5. Опубликуй правила из firestore.rules через вкладку Firestore → Rules или командой firebase deploy --only firestore:rules.
6. Опубликуй индексы из firestore.indexes.json командой firebase deploy --only firestore:indexes.
7. Настрой Authentication → Settings → Authorized domains: добавь домен GitHub Pages и localhost для разработки.

В корне есть firebase.json, поэтому Firebase CLI использует подготовленные файлы правил и индексов. Для CLI сначала выполни firebase login и firebase use --add, выбрав свой новый Firebase project.

## GitHub Pages

Workflow в .github/workflows/deploy.yml собирает приложение и публикует его в GitHub Pages. В Settings → Secrets and variables → Actions → Variables добавь:

| Variable | Значение |
|---|---|
| VITE_FIREBASE_API_KEY | Web API key |
| VITE_FIREBASE_AUTH_DOMAIN | PROJECT_ID.firebaseapp.com |
| VITE_FIREBASE_PROJECT_ID | ID проекта |
| VITE_FIREBASE_STORAGE_BUCKET | Bucket из Firebase config |
| VITE_FIREBASE_MESSAGING_SENDER_ID | Messaging sender ID |
| VITE_FIREBASE_APP_ID | App ID |

Firebase Web config предназначен для идентификации Web App и сам по себе не защищает базу. Доступ ограничивают Firestore Security Rules. Не публикуй service account private key или Admin SDK credentials в клиентском проекте.

## Вход по логину

Пользователь указывает уникальный логин (3–24 символа: латинские буквы, цифры, точка, дефис или подчёркивание) и пароль. Для совместимости со стандартным Firebase Email/Password SDK приложение преобразует логин в детерминированный технический идентификатор вида `<login>@<auth-domain>` (для текущего проекта — домен Firebase Web App из конфигурации). Пользователь не вводит реальную почту, и такой адрес не предназначен для получения писем. Поэтому стандартное восстановление пароля по email и подтверждение почты недоступны; до запуска реальной группы нужно добавить альтернативный процесс восстановления доступа. Не отключай Email/Password в Firebase Console — это используемый приложением провайдер.

## Модель Firestore

    users/{uid}                            # fullName, patronymic, username
      groups/{groupId}                 # список групп текущего пользователя

    groups/{groupId}
      members/{uid}                    # роль и имя участника
      tasks/{taskId}                   # опубликованные ДЗ
      taskSuggestions/{suggestionId}   # предложения ДЗ на модерации
      taskProgress/{taskId_uid}        # личная отметка выполнения
      lessons/{lessonId}               # расписание
      attendanceResponses/{responseId} # предварительные ответы студентов
      attendanceRecords/{recordId}     # официальный журнал старосты
      materials/{materialId}           # материалы группы
      lectures/{lectureId}             # лекции

    inviteCodes/{code}                 # разрешение кода приглашения в группу

Предложение домашнего задания и публикация связаны одной Firestore transaction: при одобрении одновременно создаётся документ задания и обновляется статус предложения. Security Rules проверяют эту атомарную связь через getAfter().

## Роли и безопасность

- Студент читает опубликованные задания своей группы, создаёт только собственные предложения и меняет только собственный прогресс.
- Староста публикует задания, рассматривает предложения и управляет расписанием.
- Предварительные ответы о посещаемости и официальный журнал хранятся в разных коллекциях.
- Официальные отметки доступны только старосте.
- Код приглашения можно получить по известному коду; перечислить все коды правила не разрешают.
- Не используй правила вида allow read, write: if request.auth != null для всей базы.

Правила из firestore.rules — начальная версия модели безопасности. Перед запуском на реальной группе протестируй роли двух аккаунтов и отказ в доступе к чужой группе через Firebase Emulator Suite / Rules Playground.

## Начальная проверка

1. Зарегистрируй первый аккаунт.
2. Создай группу — создатель автоматически становится старостой.
3. Скопируй код приглашения в разделе управления группой.
4. Зарегистрируй второй тестовый аккаунт в другом браузере или режиме инкогнито.
5. Войди вторым аккаунтом и присоединись по коду.
6. От имени студента предложи домашнее задание.
7. Вернись в аккаунт старосты и одобри предложение в разделе «Модерация».
8. Убедись, что опубликованное задание появилось у студента, а отметка выполнения меняется только у текущего пользователя.

## Что ещё предстоит

Текущая версия — MVP-каркас, а не законченный production-релиз. Следующие этапы:

1. Подключить отдельный Firebase project, опубликовать rules и indexes, проверить два аккаунта.
2. Протестировать правила через Emulator Suite и исправить замечания до приглашения реальной группы.
3. Добавить редактирование предложения старостой, комментарии при отклонении и журнал модерации.
4. Развивать библиотеку материалов и подключить отдельную структуру лекций.
5. Перенести полное расписание из study-journal.
6. Перенести журнал явки из yavka, добавить экран официальных отметок, статистику и экспорт Excel.
7. Добавить календарь дедлайнов, уведомления, realtime-подписки и сборки Android/Windows.


Посещаемость: ответ студента автоматически создаёт начальную официальную отметку («Буду» → «Был», «Не буду» → «Неуваж.»). Ручные изменения старосты сохраняются и не перезаписываются последующими ответами студента.


## Материалы группы и Firebase Storage

В разделе «Материалы» староста может загружать файлы (PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, RTF, JPG/PNG/WEBP, ZIP до 20 МБ) и добавлять внешние HTTP(S)-ссылки. Участники группы могут открывать опубликованные материалы. Удалять записи может только староста.

Для включения загрузок:

1. В Firebase Console открой Build → Storage и создай Storage bucket.
2. Проверь, что VITE_FIREBASE_STORAGE_BUCKET в GitHub Actions Variables и локальном .env совпадает с bucket из Firebase config.
3. Опубликуй правила Firestore и Storage: `firebase deploy --only firestore:rules,storage`.
4. Убедись, что проект привязан командой `firebase use --add`.

Storage Security Rules разрешают чтение только участникам соответствующей группы, а загрузку и удаление — только старосте этой группы. Файлы ограничены 20 МБ и разрешённым набором MIME-типов. Firestore хранит метаданные и путь объекта; сами файлы находятся в Storage.
