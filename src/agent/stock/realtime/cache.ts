/**
 * 极简 TTL + LRU 缓存。
 *
 * 用途：吸收前端 5 分钟轮询、用户切窗口时的连击，以及智能体并发问答，
 * 不让上游免费数据源（腾讯 / 东方财富）被打爆。
 *
 * 实现要点：
 * - 单一 Map，按插入顺序天然有序；命中时 delete + set 把 key 移到末尾，
 *   是 O(1) 的"最近使用"标记。
 * - 容量上限 64：单进程足够，2 个目标指数 × 7 个范围 × 少量自定义参数。
 * - 过期判定在读取时做（lazy expiration），不开后台定时器。
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlLruCache {
  private readonly map = new Map<string, Entry<unknown>>();
  private readonly capacity: number;

  constructor(capacity = 64) {
    this.capacity = Math.max(1, capacity);
  }

  get<T>(key: string, now = Date.now()): T | undefined {
    const entry = this.map.get(key) as Entry<T> | undefined;
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number, now = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + ttlMs });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** 仅供测试使用；生产代码不依赖此方法。 */
  clear(): void {
    this.map.clear();
  }

  /** 仅供测试使用：当前条目数。 */
  get size(): number {
    return this.map.size;
  }
}

const sharedCache = new TtlLruCache(64);

/**
 * 标准 "缓存或回源" 入口。同一 key 在 TTL 内返回上次结果，
 * 过期 / miss 时调用 loader。loader 抛错不会写入缓存。
 */
export async function getOrFetch<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  cache: TtlLruCache = sharedCache
): Promise<T> {
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;
  const value = await loader();
  cache.set(key, value, ttlMs);
  return value;
}

/** 仅供测试：清空共享缓存。 */
export function _clearSharedCache(): void {
  sharedCache.clear();
}
