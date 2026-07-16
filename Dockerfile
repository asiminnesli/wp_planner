# ===== Stage 1: Frontend Build =====
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ===== Stage 2: Backend Build =====
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

# Prisma binary target için gerekli (alpine linux)
ENV PRISMA_CLI_BINARY_TARGETS="linux-musl-openssl-3.0.x"

COPY backend/package*.json ./
COPY backend/prisma ./prisma/

RUN npm ci
RUN npx prisma generate

COPY backend/ ./
RUN npm run build

# ===== Stage 3: Production =====
FROM node:20-alpine AS runner

WORKDIR /app

# Backend
COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY --from=backend-builder /app/backend/package*.json ./backend/
COPY --from=backend-builder /app/backend/prisma ./backend/prisma

# Frontend (static files)
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

WORKDIR /app/backend

# Kalıcı data klasörünü oluştur (Render disk buraya mount edilecek)
# SQLite DB + Baileys auth burada saklanır
RUN mkdir -p /app/backend/data

ENV NODE_ENV=production

EXPOSE 3000

# db push: SQLite için migrate yerine push kullan (schema'yı otomatik uygular)
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
