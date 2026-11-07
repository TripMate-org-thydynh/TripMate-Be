/**
 * Map có trần kích thước, bỏ mục ít dùng nhất (LRU) khi đầy. Dùng cho cache
 * trong RAM của một tiến trình, để server chạy lâu không phình bộ nhớ.
 * Map của JS giữ thứ tự chèn → mục đầu tiên là mục cũ nhất.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Đưa lên cuối = vừa dùng.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
    return this;
  }

  get size(): number {
    return this.map.size;
  }
}
