import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Chuẩn hoá tên địa điểm để nhận ra hai bản ghi là một chỗ.
 *
 * Cùng một quán nhưng đọc caption ra "Suối Mơ" còn nghe lời thuyết minh ra
 * "Tiệm cà phê Suối Mơ" — không gộp thì kho phình lên toàn bản trùng và
 * người dùng nhận hai kết quả y hệt nhau.
 */
export function placeKey(name: string, city?: string | null): string {
  const strip = (t: string) =>
    t
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/d/g, 'd')
      .replace(/đ/g, 'd');
  // Bỏ tiền tố loại hình, LẶP cho hết: "tiệm cà phê Suối Mơ" phải rút được
  // cả "tiệm" lẫn "cà phê" mới trùng với "Suối Mơ". Bóc một lần là thiếu.
  const PREFIX =
    /^(tiem|quan|nha hang|cafe|ca phe|coffee|khu du lich|diem|homestay|nha nghi|khach san)\s+/;
  let bare = strip(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Dừng khi không bóc được nữa, hoặc khi bóc tiếp sẽ còn lại chuỗi rỗng
  // (tên đúng là "Cà Phê" thì phải giữ nguyên chứ không xoá sạch).
  for (let i = 0; i < 4; i++) {
    const next = bare.replace(PREFIX, '').trim();
    if (!next || next === bare) break;
    bare = next;
  }
  return `${bare}|${strip(city ?? '')}`;
}

/** UUID tất định từ một khoá chữ — nạp lại cùng dữ liệu thì ghi đè, không nhân bản. */
function stableUuid(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      h.slice(18, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Một đoạn văn bản khớp với câu hỏi, kèm mẫu chứa nó. */
export interface RagHit {
  source: 'TEMPLATE' | 'TEMPLATE_STOP' | 'TRAVEL_INSIGHT';
  templateId: string | null;
  templateTitle: string;
  content: string;
  /** 0..1, càng cao càng giống. */
  score: number;
  /** Link nội dung gốc — có với địa điểm rút từ video KOL. */
  sourceUrl?: string | null;
  sourceAuthor?: string | null;
  /** Link ảnh minh hoạ từ trang nguồn (không tải về). */
  imageUrl?: string | null;
}

/** Một địa điểm rút ra từ video du lịch, đã kèm nguồn. */
export interface TravelInsight {
  /** Khoá ổn định để nạp lại không sinh trùng (id video + tên địa điểm). */
  key: string;
  name: string;
  city?: string | null;
  /** Có khi nghe được lời thuyết minh; caption hiếm khi nêu. */
  address?: string | null;
  category?: string | null;
  priceHint?: string | null;
  openHours?: string | null;
  /** Mẹo thực tế — thứ chỉ có trong lời nói, không có trong metadata. */
  tips?: string[] | null;
  note?: string | null;
  sourceUrl: string;
  sourceAuthor?: string | null;
  /** Link ảnh minh hoạ lấy từ bài gốc — chỉ link, ảnh vẫn thuộc trang nguồn. */
  imageUrl?: string | null;
  /** Lịch trình rút từ blog: tổng chi phí và mùa nên đi. */
  totalBudgetHint?: string | null;
  bestTime?: string | null;
}

/**
 * Tìm kiếm theo NGHĨA trên kho mẫu lịch trình cộng đồng.
 *
 * Người dùng hỏi "quán cà phê yên tĩnh để ngồi đọc sách". Không quán nào tự
 * mô tả bằng đúng mấy chữ đó, nên tìm theo từ khoá trả về rỗng. Vectơ hiểu
 * được ý, nên vẫn ra "Quán của Thời Thanh Xuân — không gian tĩnh lặng".
 *
 * Chọn 768 chiều (rút gọn Matryoshka từ 3072 mặc định) vì chỉ mục HNSW của
 * pgvector chỉ nhận tới 2000 chiều. Rút gọn kiểu này là cách chính thức, chất
 * lượng giảm rất ít ở quy mô vài nghìn tài liệu.
 */
@Injectable()
export class AiEmbeddingService {
  private readonly logger = new Logger(AiEmbeddingService.name);
  private readonly apiKey: string | undefined;

  private static readonly MODEL = 'gemini-embedding-001';
  private static readonly DIM = 768;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.apiKey =
      config.get<string>('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
  }

  /**
   * Nhúng một đoạn văn bản thành vectơ.
   *
   * `taskType` khác nhau cho tài liệu và câu hỏi là có chủ ý: model nhúng hai
   * bên vào cùng không gian nhưng tối ưu riêng cho vai trò của mỗi bên, bỏ
   * qua thì chất lượng truy hồi kém đi rõ rệt.
   */
  async embed(
    text: string,
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  ): Promise<number[] | null> {
    if (!this.apiKey || !text.trim()) return null;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${AiEmbeddingService.MODEL}:embedContent?key=${this.apiKey}`,
        {
          signal: AbortSignal.timeout(20000),
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text: text.slice(0, 8000) }] },
            outputDimensionality: AiEmbeddingService.DIM,
            taskType,
          }),
        },
      );
      const json = (await res.json()) as {
        embedding?: { values?: number[] };
        error?: { message?: string };
      };
      if (json.error) {
        this.logger.warn(`Nhúng vectơ lỗi: ${json.error.message}`);
        return null;
      }
      return json.embedding?.values ?? null;
    } catch (e) {
      this.logger.warn(`Nhúng vectơ lỗi: ${(e as Error).message}`);
      return null;
    }
  }

  /** Ghi một đoạn kèm vectơ. Prisma không có kiểu vector nên phải dùng SQL thô. */
  private async upsertRow(
    source: 'TEMPLATE' | 'TEMPLATE_STOP' | 'TRAVEL_INSIGHT',
    sourceId: string,
    templateId: string | null,
    content: string,
    vec: number[],
    sourceUrl: string | null = null,
    sourceAuthor: string | null = null,
    imageUrl: string | null = null,
  ): Promise<void> {
    const literal = `[${vec.join(',')}]`;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_embeddings (id, source, source_id, template_id, content, embedding, source_url, source_author, image_url, updated_at)
       VALUES (gen_random_uuid(), $1::"EmbeddingSource", $2::uuid, $3::uuid, $4, $5::vector, $6, $7, $8, NOW())
       ON CONFLICT (source, source_id)
       DO UPDATE SET content = EXCLUDED.content,
                     embedding = EXCLUDED.embedding,
                     template_id = EXCLUDED.template_id,
                     source_url = EXCLUDED.source_url,
                     source_author = EXCLUDED.source_author,
                     image_url = EXCLUDED.image_url,
                     updated_at = NOW()`,
      source,
      sourceId,
      templateId,
      content,
      literal,
      sourceUrl,
      sourceAuthor,
      imageUrl,
    );
  }

  /**
   * Nạp địa điểm rút từ video du lịch vào kho tri thức.
   *
   * `source_id` là UUID sinh tất định từ `key`, để chạy lại cùng dữ liệu thì
   * ghi đè chứ không nhân bản thành hàng nghìn dòng trùng.
   */
  async ingestTravelInsights(rows: TravelInsight[]): Promise<number> {
    let n = 0;
    let skipped = 0;
    for (const r of rows) {
      const content = [
        r.name,
        r.city ?? '',
        r.address ?? '',
        r.category ?? '',
        r.note ?? '',
        r.priceHint ? `Giá tham khảo: ${r.priceHint}` : '',
        r.openHours ? `Giờ mở cửa: ${r.openHours}` : '',
        r.totalBudgetHint ? `Tổng chi phí tham khảo: ${r.totalBudgetHint}` : '',
        r.bestTime ? `Thời điểm nên đi: ${r.bestTime}` : '',
        (r.tips ?? []).length ? `Mẹo: ${(r.tips ?? []).join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('. ');
      // Gộp theo ĐỊA ĐIỂM chứ không theo video: hai video nói về cùng một
      // quán thì gộp làm một, không tạo dòng thứ hai.
      const id = stableUuid(placeKey(r.name, r.city));

      // Ghi đè mù quáng sẽ MẤT DỮ LIỆU: bản rút từ caption (một câu) nạp sau
      // sẽ xoá mất bản nghe được lời thuyết minh (có địa chỉ, giá, mẹo).
      // Chỉ thay khi bản mới thực sự nhiều thông tin hơn.
      const existing = await this.prisma.$queryRawUnsafe<
        Array<{ content: string }>
      >('SELECT content FROM ai_embeddings WHERE id = $1::uuid', id);
      const old = existing[0]?.content ?? '';
      if (old.length >= content.length) {
        skipped++;
        continue;
      }

      const vec = await this.embed(content, 'RETRIEVAL_DOCUMENT');
      if (!vec) continue;
      await this.upsertRow(
        'TRAVEL_INSIGHT',
        id,
        null,
        content,
        vec,
        r.sourceUrl,
        r.sourceAuthor ?? null,
        r.imageUrl ?? null,
      );
      n++;
    }
    this.logger.log(
      `Nạp ${n}/${rows.length} địa điểm từ video du lịch` +
        (skipped
          ? ` (bỏ qua ${skipped} bản nghèo thông tin hơn bản đã có)`
          : ''),
    );
    return n;
  }

  /**
   * Đánh chỉ mục lại toàn bộ mẫu công khai.
   *
   * Mỗi mẫu cho một đoạn tổng quan, mỗi điểm dừng một đoạn riêng. Chia nhỏ tới
   * mức điểm dừng là có chủ ý: câu hỏi của người dùng thường nhắm vào **một
   * chỗ cụ thể**, gộp cả mẫu thành một đoạn thì tín hiệu của quán cà phê nhỏ
   * bị chìm giữa mười mấy địa điểm khác.
   *
   * Trả về số đoạn đã ghi.
   */
  async reindexTemplates(): Promise<{ indexed: number; skipped: number }> {
    const templates = await this.prisma.itineraryTemplate.findMany({
      where: { isPublic: true, deletedAt: null },
      include: { items: true },
    });

    let indexed = 0;
    let skipped = 0;

    for (const t of templates) {
      const overview = [
        t.title,
        t.destination ?? '',
        t.description ?? '',
        t.tags.join(', '),
      ]
        .filter(Boolean)
        .join('. ');
      const vec = await this.embed(overview, 'RETRIEVAL_DOCUMENT');
      if (vec) {
        await this.upsertRow('TEMPLATE', t.id, t.id, overview, vec);
        indexed++;
      } else {
        skipped++;
      }

      for (const it of t.items) {
        const chunk = [
          it.placeName,
          it.placeAddress ?? '',
          it.notes ?? '',
          it.category ?? '',
          `(trong lịch trình "${t.title}"${t.destination ? ` ở ${t.destination}` : ''})`,
        ]
          .filter(Boolean)
          .join('. ');
        const v = await this.embed(chunk, 'RETRIEVAL_DOCUMENT');
        if (v) {
          await this.upsertRow('TEMPLATE_STOP', it.id, t.id, chunk, v);
          indexed++;
        } else {
          skipped++;
        }
      }
    }
    this.logger.log(`Đánh chỉ mục xong: ${indexed} đoạn, bỏ qua ${skipped}`);
    return { indexed, skipped };
  }

  /**
   * Đánh chỉ mục một mẫu. Dùng khi vừa xuất bản, khỏi phải quét lại cả kho.
   *
   * Mẫu riêng tư thì gỡ khỏi chỉ mục thay vì ghi vào: tìm kiếm chỉ trả về mẫu
   * công khai, để sót lại là rò nội dung riêng của người khác.
   */
  async indexTemplate(templateId: string): Promise<number> {
    const t = await this.prisma.itineraryTemplate.findUnique({
      where: { id: templateId },
      include: { items: true },
    });
    if (!t || !t.isPublic || t.deletedAt) {
      await this.removeTemplate(templateId);
      return 0;
    }

    let n = 0;
    const overview = [
      t.title,
      t.destination ?? '',
      t.description ?? '',
      t.tags.join(', '),
    ]
      .filter(Boolean)
      .join('. ');
    const vec = await this.embed(overview, 'RETRIEVAL_DOCUMENT');
    if (vec) {
      await this.upsertRow('TEMPLATE', t.id, t.id, overview, vec);
      n++;
    }
    for (const it of t.items) {
      const chunk = [
        it.placeName,
        it.placeAddress ?? '',
        it.notes ?? '',
        it.category ?? '',
        `(trong lịch trình "${t.title}"${t.destination ? ` ở ${t.destination}` : ''})`,
      ]
        .filter(Boolean)
        .join('. ');
      const v = await this.embed(chunk, 'RETRIEVAL_DOCUMENT');
      if (v) {
        await this.upsertRow('TEMPLATE_STOP', it.id, t.id, chunk, v);
        n++;
      }
    }
    return n;
  }

  /** Xoá chỉ mục của một mẫu (khi mẫu bị gỡ hoặc sửa). */
  async removeTemplate(templateId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      'DELETE FROM ai_embeddings WHERE template_id = $1::uuid',
      templateId,
    );
  }

  /**
   * Các đoạn gần nghĩa nhất với [query].
   *
   * `minScore` lọc bỏ kết quả gần như không liên quan. Không có ngưỡng thì
   * câu hỏi nào cũng trả về k đoạn — kể cả khi kho chẳng có gì hợp — và model
   * sẽ bám vào chúng mà bịa.
   *
   * Ngưỡng 0.63 là **đo ra chứ không đoán**. Điểm cosine của model này dồn
   * cụm rất hẹp nên trực giác "0.5 là một nửa giống nhau" sai hoàn toàn:
   *
   * | Câu hỏi                               | Điểm cao nhất |
   * |---------------------------------------|---------------|
   * | "thác nước có máng trượt" (đúng)      | 0.729         |
   * | "chỗ yên tĩnh ngồi đọc sách" (đúng)   | 0.668         |
   * | "tỷ giá đô la hôm nay" (lạc đề)       | 0.569         |
   * | "cài máy in HP trên Windows" (lạc đề) | 0.488         |
   *
   * Ngưỡng 0.45 ban đầu cho lọt cả câu hỏi tỷ giá. Khoảng cách giữa đúng và
   * lạc đề chỉ 0.1, nên đo lại mỗi khi đổi model nhúng.
   */
  async search(query: string, k = 5, minScore = 0.63): Promise<RagHit[]> {
    const vec = await this.embed(query, 'RETRIEVAL_QUERY');
    if (!vec) return [];
    const literal = `[${vec.join(',')}]`;
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{
          source: 'TEMPLATE' | 'TEMPLATE_STOP' | 'TRAVEL_INSIGHT';
          template_id: string | null;
          title: string | null;
          source_url: string | null;
          source_author: string | null;
          image_url: string | null;
          content: string;
          distance: number;
        }>
      >(
        `SELECT e.source, e.template_id, t.title, e.source_url, e.source_author, e.image_url,
                e.content, (e.embedding <=> $1::vector) AS distance
           FROM ai_embeddings e
           LEFT JOIN itinerary_templates t ON t.id = e.template_id
          WHERE e.embedding IS NOT NULL
            -- Nguồn ngoài không thuộc mẫu nào; mẫu thì phải còn công khai.
            AND (
              e.template_id IS NULL
              OR (t.deleted_at IS NULL AND t.is_public = true)
            )
          ORDER BY e.embedding <=> $1::vector
          LIMIT $2`,
        literal,
        k,
      );
      return (
        rows
          // `<=>` là khoảng cách cosine (0 = trùng khớp), đổi sang điểm giống nhau.
          .map((r) => ({
            source: r.source,
            templateId: r.template_id,
            templateTitle: r.title ?? r.source_author ?? 'Video du lịch',
            content: r.content,
            score: 1 - Number(r.distance),
            sourceUrl: r.source_url,
            sourceAuthor: r.source_author,
            imageUrl: r.image_url,
          }))
          .filter((h) => h.score >= minScore)
      );
    } catch (e) {
      this.logger.warn(`Tìm theo nghĩa lỗi: ${(e as Error).message}`);
      return [];
    }
  }

  async count(): Promise<number> {
    const r = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT COUNT(*)::bigint AS n FROM ai_embeddings',
    );
    return Number(r[0]?.n ?? 0);
  }
}
