# cleaning

Отдельный backend AI Cleaning Ecosystem: TypeScript, Fastify, PostgreSQL, Prisma и OpenAI Responses API.

## Что находится в репозитории

- REST API и бизнес-логика — `apps/api/src`
- Prisma-схема, миграции и seed — `apps/api/prisma`
- OpenAPI-контракт — `apps/api/openapi.yaml`
- общий модуль расчёта цены и scoring — `packages/shared`
- AI Quality/Vision, Risk, Forecast и Review NLP — `apps/api/src/ai.ts`

## Локальный запуск

Требования: Node.js 20+ и PostgreSQL.

```bash
npm install
```

Скопируйте `apps/api/.env.example` в `apps/api/.env` или задайте переменные окружения в терминале. Главная обязательная переменная:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_cleaning?schema=public
```

Затем выполните:

```bash
npm run db:deploy
npm run db:seed
npm run dev
```

По умолчанию seed обновляет только каталог услуг. Локальные demo-аккаунты создаются только при
`SEED_DEMO_USERS=true` и пароле `SEED_DEMO_PASSWORD` длиной не менее 12 символов. При
`NODE_ENV=production` создание demo-пользователей запрещено.

API будет доступен на `http://localhost:4000`, проверка состояния — `GET /health`.

## Проверка

```bash
npm run build
npm test
```

Полный E2E-тест с базой запускается, если задана отдельная переменная `TEST_DATABASE_URL`.

## Развёртывание на Render

Создайте PostgreSQL и Web Service из этого GitHub-репозитория.

- Build Command: `npm ci && npm run build`
- Pre-Deploy Command: `npm run db:deploy`
- Start Command: `npm start`
- Health Check Path: `/health`

Переменные окружения:

```env
DATABASE_URL=<Internal Database URL из Render PostgreSQL>
NODE_ENV=production
ENABLE_DEMO_LOGIN=false
CORS_ORIGIN=https://ваш-разрешённый-домен
SESSION_TTL_DAYS=30
MAX_PROOF_BYTES=10485760
REQUEST_BODY_LIMIT_BYTES=26214400
PAYOUT_RATIO=0.72
OPENAI_API_KEY=<новый секретный серверный ключ>
OPENAI_MODEL=gpt-5.6-luna
OPENAI_TIMEOUT_MS=45000
```

Фото и MP4-доказательства MVP сохраняются в `apps/api/storage`. Для MP4 Android передаёт три репрезентативных JPEG-кадра для Vision-анализа. Чтобы медиа не исчезало после перезапуска сервиса, подключите Persistent Disk к `/opt/render/project/src/apps/api/storage`.

Если `OPENAI_API_KEY` не задан или провайдер временно недоступен, API продолжит работу в явно помеченном режиме `FALLBACK`. Этот режим не выдаётся за анализ содержимого фотографии. Финальное решение контроля качества всегда принимает менеджер.

Не добавляйте настоящие `.env`-файлы и секреты в Git.
