import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Tra cứu web cho trợ lý AI: tìm kiếm (DuckDuckGo HTML, không cần key) rồi
 * crawl vài trang đầu, rút chữ để đưa vào prompt kèm link nguồn.
 *
 * Mô phỏng `research/sources.py` của Reelforge: mọi lượt tải đều qua chốt
 * SSRF (chặn IP nội bộ, kiểm lại sau mỗi redirect), giới hạn byte, thời gian,
 * và chỉ nhận HTML. Chữ lấy về là nội dung không tin cậy — người gọi phải
 * bọc bằng `wrapUntrusted`.
 */
export interface WebSource {
  title: string;
  url: string;
  snippet: string;
  /** Chữ rút từ trang; rỗng khi không crawl được (vẫn còn snippet). */
  text: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const MAX_BYTES = 1_500_000;
const MAX_TEXT = 2500;
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_REDIRECTS = 3;
const GROUNDING_MODEL = 'gemini-3.8-flash';
const GROUNDING_TIMEOUT_MS = 8000;
// Trang không phải bài viết (mạng xã hội, video, tài liệu) — lọc theo LOẠI trang.
const NOT_ARTICLE_HOST =
  /(^|\.)(facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|scribd\.com|threads\.net)$/;

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return (
      v === '::1' ||
      v === '::' ||
      v.startsWith('fc') ||
      v.startsWith('fd') ||
      v.startsWith('fe80')
    );
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('scheme');
  }
  if (u.username || u.password) throw new Error('credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('private address');
  }
  return u;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    );
}

const fold = (t: string) =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

// Trang công cụ tìm kiếm/dịch không phải nguồn — Bing hay nhả chúng khi nghi bot.
const JUNK_HOST =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|translate\.goog|microsoft\.com)$/;

/**
 * Giữ kết quả có ít nhất nửa số từ khoá (tối thiểu 2) của câu hỏi (bỏ dấu) trong tiêu đề,
 * đoạn trích hoặc link — lọc kết quả rác không liên quan.
 */
function relevant(query: string, results: WebSource[]): WebSource[] {
  const words = [
    ...new Set(
      fold(query)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 2),
    ),
  ];
  // Tối thiểu nửa số từ khoá: câu hỏi dài mà khớp 2 chữ phổ thông ("quan", "ha") là rác.
  const need = Math.max(Math.min(2, words.length), Math.ceil(words.length / 2));
  return results.filter((r) => {
    let host = '';
    try {
      host = new URL(r.url).hostname;
    } catch {
      return false;
    }
    if (JUNK_HOST.test(host)) return false;
    const hay = fold(`${r.title} ${r.snippet} ${r.url.replace(/[-_/]/g, ' ')}`);
    const tokens = new Set(hay.split(/[^a-z0-9]+/));
    const hits = words.filter((w) => tokens.has(w));
    return hits.length >= need;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML → chữ thuần: bỏ script/style/nav/footer, giữ ngắt đoạn. */
export function htmlToText(html: string): string {
  const body = html
    .replace(
      /<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Ưu tiên <article>/<main> nếu có — ít menu, quảng cáo hơn.
  const main =
    /<article[\s\S]*?<\/article>/i.exec(body)?.[0] ??
    /<main[\s\S]*?<\/main>/i.exec(body)?.[0] ??
    body;
  return decodeEntities(
    main
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 30)
    .join('\n');
}

/**
 * Chọn các đoạn liên quan câu hỏi thay vì cắt 2500 ký tự ĐẦU trang: giá vé,
 * giờ mở cửa thường nằm giữa hoặc cuối bài, phần đầu toàn lời dẫn.
 * Giữ nguyên thứ tự xuất hiện để đoạn văn còn đọc được.
 */
export function pickPassages(text: string, query: string): string {
  if (text.length <= MAX_TEXT) return text;
  const words = [
    ...new Set(
      fold(query)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 2),
    ),
  ];
  // Từ gợi ý thông tin thực dụng — luôn được cộng điểm.
  const PRACTICAL = /\d|\bgia\b|\bve\b|\bgio\b|mo cua|dia chi|\bphi\b|vnd|dong/;
  const paras = text.split('\n').map((p, i) => {
    const f = fold(p);
    const tokens = new Set(f.split(/[^a-z0-9]+/));
    const score =
      words.filter((w) => tokens.has(w)).length +
      (PRACTICAL.test(f) ? 1 : 0) +
      (i === 0 ? 1 : 0); // đoạn đầu thường nêu đối tượng của bài
    return { i, p, score };
  });
  const chosen: typeof paras = [];
  let size = 0;
  for (const x of [...paras].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (x.score === 0 || size + x.p.length > MAX_TEXT) continue;
    chosen.push(x);
    size += x.p.length + 1;
  }
  return chosen
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p)
    .join('\n');
}

@Injectable()
export class WebResearchService {
  private readonly logger = new Logger(WebResearchService.name);
  private readonly cache = new Map<string, { at: number; data: WebSource[] }>();
  private readonly apiKey: string | undefined;

  constructor(config: ConfigService) {
    this.apiKey =
      config.get<string>('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
  }

  /** Tải có chốt SSRF, tự theo redirect (kiểm lại từng bước), giới hạn byte. */
  private async safeFetch(url: string, init?: RequestInit): Promise<string> {
    let current = url;
    let reqInit = init;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(current);
      const res = await fetch(current, {
        ...reqInit,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': UA,
          ...(reqInit?.headers ?? {}),
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('redirect without location');
        current = new URL(loc, current).toString();
        reqInit = undefined; // redirect của POST → GET
        continue;
      }
      // DDG trả 202 kèm trang trắng khi nghi bot — coi như lỗi.
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/.test(type)) {
        throw new Error(`type ${type}`);
      }
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) throw new Error('too large');
      const reader = res.body?.getReader();
      if (!reader) return '';
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new Error('too many redirects');
  }

  /**
   * Google Search qua Gemini (công cụ google_search chính thức) trước; DDG
   * rồi Bing chỉ là dự phòng. Cào HTML công cụ tìm kiếm không trụ được: DDG
   * trả 202 (tường chống bot), Bing trả kết quả lạc đề, nơi khác đòi captcha.
   */
  async search(query: string, limit = 5): Promise<WebSource[]> {
    try {
      const g = await this.searchGoogle(query, limit);
      if (g.length > 0) return g;
    } catch (e) {
      this.logger.debug(`Google (Gemini) lỗi, chuyển DDG: ${String(e)}`);
    }
    try {
      const ddg = relevant(query, await this.searchDdg(query, limit + 3));
      if (ddg.length > 0) return ddg.slice(0, limit);
    } catch (e) {
      this.logger.debug(`DDG lỗi, chuyển Bing: ${String(e)}`);
    }
    return relevant(query, await this.searchBing(query, limit + 3)).slice(
      0,
      limit,
    );
  }

  /**
   * Gemini trả link nguồn trong groundingMetadata dưới dạng link chuyển hướng
   * của Google; đọc header Location (không tải trang) để lấy URL thật.
   */
  private async searchGoogle(
    query: string,
    limit: number,
  ): Promise<WebSource[]> {
    if (!this.apiKey) return [];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GROUNDING_MODEL}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(GROUNDING_TIMEOUT_MS),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    'Tìm trên Google các bài blog, cẩm nang, trang chính thức ' +
                    `bằng tiếng Việt trả lời câu hỏi du lịch sau: ${query}. ` +
                    'Tóm tắt rất ngắn.',
                },
              ],
            },
          ],
          tools: [{ google_search: {} }],
          // Chỉ cần danh sách nguồn — tắt suy nghĩ cho nhanh.
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    const json = (await res.json()) as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>;
      error?: { message?: string };
    };
    if (json.error) throw new Error(json.error.message);
    const chunks =
      json.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const resolved = await Promise.all(
      chunks.slice(0, limit + 3).map(async (c) => {
        const uri = c.web?.uri;
        if (!uri) return null;
        try {
          const r = await fetch(uri, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          const loc = r.headers.get('location');
          if (!loc) return null;
          const host = new URL(loc).hostname;
          if (NOT_ARTICLE_HOST.test(host)) return null;
          return {
            url: loc,
            title: c.web?.title ?? host,
            snippet: '',
            text: '',
          } satisfies WebSource;
        } catch {
          return null;
        }
      }),
    );
    const seen = new Set<string>();
    return resolved
      .filter((r): r is WebSource => r != null)
      .filter((r) => !seen.has(r.url) && seen.add(r.url))
      .slice(0, limit);
  }

  private async searchDdg(query: string, limit: number): Promise<WebSource[]> {
    const html = await this.safeFetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query, kl: 'vn-vi' }).toString(),
    });
    const out: WebSource[] = [];
    const re =
      /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of html.matchAll(re)) {
      let url = decodeEntities(m[1]);
      // Link bọc qua trang chuyển hướng của DDG: lấy tham số uddg.
      if (url.includes('duckduckgo.com/l/')) {
        const real = new URL(url, SEARCH_URL).searchParams.get('uddg');
        if (!real) continue;
        url = real;
      }
      if (url.includes('duckduckgo.com/y.js')) continue; // quảng cáo
      out.push({
        url,
        title: stripTags(m[2]),
        snippet: stripTags(m[3]),
        text: '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private async searchBing(query: string, limit: number): Promise<WebSource[]> {
    const html = await this.safeFetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=vi&cc=VN`,
    );
    const out: WebSource[] = [];
    for (const block of html.split('<li class="b_algo"').slice(1)) {
      const a = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
        block,
      );
      if (!a) continue;
      let url = decodeEntities(a[1]);
      // /ck/a?...&u=a1<base64url của link thật>
      if (url.includes('bing.com/ck/a')) {
        const u = new URL(url).searchParams.get('u');
        if (!u?.startsWith('a1')) continue;
        url = Buffer.from(u.slice(2), 'base64url').toString('utf8');
      }
      if (!/^https?:\/\//.test(url)) continue;
      const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
      out.push({
        url,
        title: stripTags(a[2]),
        snippet: p ? stripTags(p[1]) : '',
        text: '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Tìm rồi crawl song song `crawl` trang đầu. Không bao giờ ném lỗi: mạng
   * hỏng thì trả [] để AI vẫn trả lời bằng tri thức sẵn có.
   */
  async research(query: string, crawl = 3): Promise<WebSource[]> {
    const key = query.trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    try {
      const results = await this.search(query, 5);
      await Promise.all(
        results.slice(0, crawl).map(async (r) => {
          try {
            r.text = pickPassages(
              htmlToText(await this.safeFetch(r.url)),
              query,
            );
          } catch (e) {
            this.logger.debug(`Crawl bỏ qua ${r.url}: ${String(e)}`);
          }
        }),
      );
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, { at: Date.now(), data: results });
      return results;
    } catch (e) {
      this.logger.warn(`Tra cứu web lỗi: ${String(e)}`);
      return [];
    }
  }

  /** Gói kết quả thành khối chữ cho prompt, đánh số để AI trích nguồn. */
  static format(sources: WebSource[]): string {
    return sources
      .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.text || s.snippet}`)
      .join('\n\n');
  }
}
