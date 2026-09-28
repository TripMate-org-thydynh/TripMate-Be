-- CreateTable
CREATE TABLE "ai_response_cache" (
    "key" TEXT NOT NULL,
    "type" "AIRequestType" NOT NULL,
    "response" JSONB NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_response_cache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ai_corrections" (
    "id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "correction" TEXT NOT NULL,
    "created_by" UUID,
    "is_approved" BOOLEAN NOT NULL DEFAULT false,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_response_cache_expires_at_idx" ON "ai_response_cache"("expires_at");

-- CreateIndex
CREATE INDEX "ai_corrections_is_approved_idx" ON "ai_corrections"("is_approved");

