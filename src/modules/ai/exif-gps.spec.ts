import { readGps, extractExifChunk } from './exif-gps';

/**
 * Dựng TIFF/EXIF tối thiểu chứa GPS (little-endian) để test không cần ảnh thật.
 * Cấu trúc: header → IFD0 (trỏ tới GPS IFD) → GPS IFD → dữ liệu rational.
 */
function tiffWithGps(
  lat: [number, number, number],
  lng: [number, number, number],
) {
  const b = Buffer.alloc(300);
  let p = 0;
  b.write('II', p);
  p += 2; // little-endian
  b.writeUInt16LE(42, p);
  p += 2;
  b.writeUInt32LE(8, p);
  p += 4; // offset IFD0

  // IFD0: 1 entry trỏ sang GPS IFD
  const ifd0 = 8;
  b.writeUInt16LE(1, ifd0);
  b.writeUInt16LE(0x8825, ifd0 + 2); // GPSInfoIFDPointer
  b.writeUInt16LE(4, ifd0 + 4); // LONG
  b.writeUInt32LE(1, ifd0 + 6);
  const gpsIfd = 30;
  b.writeUInt32LE(gpsIfd, ifd0 + 10);
  b.writeUInt32LE(0, ifd0 + 14); // không có IFD tiếp theo

  // GPS IFD: 4 entry
  const dataStart = gpsIfd + 2 + 4 * 12 + 4;
  b.writeUInt16LE(4, gpsIfd);
  const entry = (
    i: number,
    tag: number,
    type: number,
    count: number,
    value: number,
    asOffset = true,
  ) => {
    const o = gpsIfd + 2 + i * 12;
    b.writeUInt16LE(tag, o);
    b.writeUInt16LE(type, o + 2);
    b.writeUInt32LE(count, o + 4);
    if (asOffset) b.writeUInt32LE(value, o + 8);
    else b.writeUInt8(value, o + 8);
  };
  // 1=LatRef(ASCII 'N'), 2=Lat(3 rational), 3=LngRef('E'), 4=Lng(3 rational)
  entry(0, 1, 2, 2, 'N'.charCodeAt(0), false);
  entry(1, 2, 5, 3, dataStart);
  entry(2, 3, 2, 2, 'E'.charCodeAt(0), false);
  entry(3, 4, 5, 3, dataStart + 24);
  b.writeUInt32LE(0, gpsIfd + 2 + 4 * 12);

  const writeRationals = (off: number, vals: [number, number, number]) => {
    vals.forEach((v, i) => {
      b.writeUInt32LE(Math.round(v * 100), off + i * 8);
      b.writeUInt32LE(100, off + i * 8 + 4);
    });
  };
  writeRationals(dataStart, lat);
  writeRationals(dataStart + 24, lng);
  return b.subarray(0, dataStart + 48);
}

/** Gói một buffer EXIF vào container WebP (RIFF) tối thiểu. */
function webpWithExif(exif: Buffer) {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0);
  head.write('WEBP', 8);
  const chunk = Buffer.alloc(8 + exif.length + (exif.length % 2));
  chunk.write('EXIF', 0);
  chunk.writeUInt32LE(exif.length, 4);
  exif.copy(chunk, 8);
  head.writeUInt32LE(4 + chunk.length, 4);
  return Buffer.concat([head, chunk]);
}

/** Gói vào PNG (chunk eXIf). */
function pngWithExif(exif: Buffer) {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const chunk = Buffer.alloc(12 + exif.length);
  chunk.writeUInt32BE(exif.length, 0);
  chunk.write('eXIf', 4);
  exif.copy(chunk, 8);
  return Buffer.concat([sig, chunk]);
}

describe('readGps', () => {
  // 16°04'41.4" N, 108°16'05.4" E — Đỉnh Bàn Cờ, Sơn Trà, Đà Nẵng.
  const exif = tiffWithGps([16, 4, 41.4], [108, 16, 5.4]);

  it('đọc được GPS trong ảnh WebP (exifr không tự mở được định dạng này)', async () => {
    const gps = await readGps(webpWithExif(exif));
    expect(gps).not.toBeNull();
    expect(gps!.latitude).toBeCloseTo(16.0782, 3);
    expect(gps!.longitude).toBeCloseTo(108.2682, 3);
  });

  it('đọc được GPS trong PNG (chunk eXIf)', async () => {
    const gps = await readGps(pngWithExif(exif));
    expect(gps!.latitude).toBeCloseTo(16.0782, 3);
  });

  it('đọc được EXIF thô (TIFF) trực tiếp', async () => {
    const gps = await readGps(exif);
    expect(gps!.longitude).toBeCloseTo(108.2682, 3);
  });

  it('ảnh không có EXIF → null, không ném lỗi', async () => {
    expect(await readGps(Buffer.from('khong-phai-anh'))).toBeNull();
    expect(await readGps(webpWithExif(Buffer.alloc(0)))).toBeNull();
  });

  it('file WebP cắt dở không làm đổ chương trình', () => {
    const cut = webpWithExif(exif).subarray(0, 14);
    expect(extractExifChunk(cut)).toBeNull();
  });
});
