# --- STAGE 1: BUILD CHASSIS ---
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ENV DIRECT_URL="postgresql://dummy:dummy@localhost:5432/dummy"

COPY package*.json ./
COPY prisma ./prisma/

# Install both dependencies and devDependencies for compiler compilation
RUN npm ci

COPY . .

# Generate the Prisma Client
RUN npx prisma generate

# Compile TypeScript NestJS application into dist/
RUN npm run build

# --- STAGE 2: PRODUCTION RUNNER ---
FROM node:20-alpine AS runner
WORKDIR /usr/src/app

COPY package*.json ./
COPY prisma ./prisma/

# Install only production-level dependencies to minimize image footprint
RUN npm ci --only=production

# Copy compiled source files and the generated Prisma Client from Stage 1
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma

ENV NODE_ENV=production
EXPOSE 3000

# Start NestJS backend production server
CMD ["node", "dist/main"]
