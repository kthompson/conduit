/** A single-consumer async queue. `end()` drains what is buffered, then stops iteration. */
export class Channel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  push(value: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.end();
        this.buffer.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
