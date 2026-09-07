/**
 * Tiện ích chuẩn hoá nhãn route và lọc đường dẫn cho hệ thống Observability / Metrics.
 */

/**
 * Xác định xem đường dẫn có nằm trong danh sách loại trừ đo lường hay không.
 *
 * Loại trừ:
 * - /health và /api/v1/health (cũng như kết thúc bằng /health)
 * - /admin/observability và /api/v1/admin/observability (tránh dashboard tự đo chính nó gây nhiễu)
 */
export function isExcludedPath(pathOrUrl: string): boolean {
  if (!pathOrUrl) return false;

  // Tách query string và hash, loại bỏ khoảng trắng
  const cleanPath = pathOrUrl.split('?')[0].split('#')[0].trim();

  // 1. Health checks (/health, /api/v1/health, ...)
  if (
    cleanPath === '/health' ||
    cleanPath === '/api/v1/health' ||
    cleanPath.endsWith('/health')
  ) {
    return true;
  }

  // 2. Observability dashboard routes (/admin/observability, /api/v1/admin/observability, ...)
  if (
    cleanPath.startsWith('/admin/observability') ||
    cleanPath.startsWith('/api/v1/admin/observability')
  ) {
    return true;
  }

  return false;
}

/**
 * Trích xuất route pattern chuẩn hoá (ví dụ: `/trips/:tripId/expenses`),
 * TUYỆT ĐỐI không dùng URL thật để tránh nổ cardinality.
 * Nếu không lấy được route pattern từ router của Express (ví dụ 404 thật sự), gom vào nhãn `'unknown'`.
 */
export function extractRoutePattern(req: any): string {
  if (!req || !req.route || typeof req.route.path !== 'string') {
    return 'unknown';
  }

  const routePath = req.route.path;
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';

  if (!baseUrl) {
    return routePath.startsWith('/') ? routePath : `/${routePath}`;
  }

  // Nếu routePath đã bao gồm baseUrl (khi Nest đăng ký route toàn cục), không ghép lặp
  if (routePath.startsWith(baseUrl)) {
    return routePath;
  }

  const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const cleanPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  let combined = `${cleanBase}${cleanPath}`;
  if (combined.length > 1 && combined.endsWith('/')) {
    combined = combined.slice(0, -1);
  }
  return combined;
}
