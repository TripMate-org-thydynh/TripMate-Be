import * as exifr from 'exifr';

export interface GpsPoint {
  latitude: number;
  longitude: number;
  /** Thời điểm chụp, nếu ảnh có ghi. */
  takenAt?: Date;
}

/**
 * Lấy GPS từ ảnh, hỗ trợ cả định dạng `exifr` không tự mở được.
 *
 * - JPEG/TIFF/HEIC: `exifr` đọc thẳng.
 * - WebP: `exifr` báo "Unknown file format". WebP là container RIFF, EXIF nằm
 *   trong khối tên `EXIF` — cắt khối đó ra rồi đưa lại cho `exifr`.
 * - PNG: EXIF nằm trong chunk `eXIf` (PNG 1.5+), cắt tương tự.
 *
 * Trả `null` khi ảnh không có toạ độ (rất thường gặp: ảnh gửi qua Zalo/Messenger
 * hay trình chọn ảnh Android 13+ đều bị xoá vị trí).
 */
export async function readGps(buffer: Buffer): Promise<GpsPoint | null> {
  for (const buf of [buffer, extractExifChunk(buffer)]) {
    if (!buf) continue;
    const hit = await tryParse(buf);
    if (hit) return hit;
  }
  return null;
}

async function tryParse(buf: Buffer): Promise<GpsPoint | null> {
  try {
    const gps = await exifr.gps(buf);
    if (
      gps &&
      typeof gps.latitude === 'number' &&
      typeof gps.longitude === 'number' &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      !(gps.latitude === 0 && gps.longitude === 0)
    ) {
      const meta = await exifr
        .parse(buf, ['DateTimeOriginal'])
        .catch(() => null);
      const taken = (meta as { DateTimeOriginal?: Date } | null)
        ?.DateTimeOriginal;
      return {
        latitude: gps.latitude,
        longitude: gps.longitude,
        takenAt: taken instanceof Date ? taken : undefined,
      };
    }
  } catch {
    // Định dạng không đọc được → thử cách khác ở vòng ngoài.
  }
  return null;
}

/** Cắt khối EXIF của WebP (RIFF) hoặc PNG ra thành buffer TIFF độc lập. */
export function extractExifChunk(buf: Buffer): Buffer | null {
  try {
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
      return extractRiffExif(buf);
    }
    if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') {
      return extractPngExif(buf);
    }
  } catch {
    // File hỏng/cắt dở — coi như không có EXIF.
  }
  return null;
}

function extractRiffExif(buf: Buffer): Buffer | null {
  // RIFF: "RIFF" | size(4) | "WEBP" | các khối: tag(4) | size(4) | data
  let p = 12;
  while (p + 8 <= buf.length) {
    const tag = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const start = p + 8;
    if (start + size > buf.length) return null;
    if (tag === 'EXIF')
      return withTiffHeader(buf.subarray(start, start + size));
    // Khối có kích thước lẻ được chèn 1 byte đệm.
    p = start + size + (size % 2);
  }
  return null;
}

function extractPngExif(buf: Buffer): Buffer | null {
  // PNG: 8 byte chữ ký, rồi các chunk: length(4) | type(4) | data | crc(4)
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const start = p + 8;
    if (start + len > buf.length) return null;
    if (type === 'eXIf')
      return withTiffHeader(buf.subarray(start, start + len));
    if (type === 'IEND') return null;
    p = start + len + 4;
  }
  return null;
}

/** Bỏ tiền tố "Exif\0\0" nếu có, để còn lại đúng TIFF header cho exifr. */
function withTiffHeader(data: Buffer): Buffer | null {
  if (data.length < 8) return null;
  if (data.toString('ascii', 0, 4) === 'Exif') return data.subarray(6);
  return data;
}
