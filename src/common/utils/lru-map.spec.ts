import { LruMap } from './lru-map';

describe('LruMap', () => {
  it('không vượt trần và bỏ mục ít dùng nhất', () => {
    const m = new LruMap<string, number>(2);
    m.set('a', 1).set('b', 2);
    m.get('a'); // a vừa dùng → b là cũ nhất
    m.set('c', 3);
    expect(m.size).toBe(2);
    expect(m.has('b')).toBe(false);
    expect(m.get('a')).toBe(1);
    expect(m.get('c')).toBe(3);
  });

  it('giữ được giá trị null (kết quả "không tìm thấy" cũng được cache)', () => {
    const m = new LruMap<string, null>(1);
    m.set('x', null);
    expect(m.has('x')).toBe(true);
    expect(m.get('x')).toBeNull();
  });
});
