// 동시 실행 개수를 제한하는 단순한 작업 큐
export class JobQueue {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get pending() {
    return this.waiting.length;
  }

  get isFull() {
    return this.running >= this.limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
