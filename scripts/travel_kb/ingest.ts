/**
 * Nạp địa điểm đã rút từ video KOL vào kho tri thức (bảng ai_embeddings).
 *
 * Đầu vào là JSONL do `deep_extract.py` (video) hoặc `discover.py` (blog,
 * trang web) ghi ra — mỗi dòng một địa điểm hoặc một lịch trình.
 * Dùng JSONL chứ không phải JSON để lần chạy bị chặn giữa chừng vẫn giữ
 * được phần đã làm.
 *
 *   npx ts-node scripts/travel_kb/ingest.ts <file.jsonl>
 */
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { AppModule } from '../../src/app.module';
import {
  AiEmbeddingService,
  TravelInsight,
} from '../../src/modules/ai/ai-embedding.service';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('Thiếu đường dẫn file .jsonl');
    process.exit(1);
  }

  const rows: TravelInsight[] = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((r) => ({
      // `deep_extract.py` gọi là priceVnd, kho tri thức gọi là priceHint.
      key: String(r.sourceUrl ?? '') + '|' + String(r.name ?? ''),
      name: String(r.name ?? ''),
      city: (r.city as string) ?? null,
      address: (r.address as string) ?? null,
      category: (r.category as string) ?? null,
      priceHint: (r.priceVnd as string) ?? null,
      openHours: (r.openHours as string) ?? null,
      tips: (r.tips as string[]) ?? null,
      note: (r.note as string) ?? null,
      sourceUrl: String(r.sourceUrl ?? ''),
      sourceAuthor: (r.sourceAuthor as string) ?? null,
      imageUrl: (r.imageUrl as string) ?? null,
      totalBudgetHint: (r.totalBudgetHint as string) ?? null,
      bestTime: (r.bestTime as string) ?? null,
    }))
    .filter((r) => r.name && r.sourceUrl);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const n = await app.get(AiEmbeddingService).ingestTravelInsights(rows);
    console.log(`đọc ${rows.length} dòng, ghi ${n} địa điểm vào kho tri thức`);
  } finally {
    await app.close();
  }
}

void main();
