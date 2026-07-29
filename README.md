# cleaning

Отдельный backend AI Cleaning Ecosystem: TypeScript, Fastify, PostgreSQL и Prisma.

## Что находится в репозитории

- REST API и бизнес-логика — `apps/api/src`
- Prisma-схема, миграции и seed — `apps/api/prisma`
- OpenAPI-контракт — `apps/api/openapi.yaml`
- общий модуль расчёта цены и scoring — `packages/shared`

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
CURRENCY=KZT
SESSION_TTL_DAYS=30
MAX_PROOF_BYTES=10485760
REQUEST_BODY_LIMIT_BYTES=15728640
PAYOUT_RATIO=0.72
```

Фотодоказательства MVP сохраняются в `apps/api/storage`. Чтобы они не исчезали после перезапуска сервиса, подключите Persistent Disk к `/opt/render/project/src/apps/api/storage`.

Не добавляйте настоящие `.env`-файлы и секреты в Git.
