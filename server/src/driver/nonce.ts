// Serial nonce allocator for a single sender. The chain's pending count is the source of truth on (re)sync;
// afterwards nonces are handed out locally so several games can pipeline without racing getTransactionCount.
export class NonceManager {
  private next: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly fetchPending: () => Promise<number>) {}

  /**
   * Runs `fn(nonce)` with exclusive access to nonce allocation. If fn resolves, the nonce is consumed;
   * if it throws `NonceNotConsumed` (tx was never broadcast) the nonce is returned to the pool.
   */
  async withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.next === null) this.next = await this.fetchPending();
      const nonce = this.next;
      try {
        const out = await fn(nonce);
        this.next = nonce + 1;
        return out;
      } catch (e) {
        if (!(e instanceof NonceNotConsumed)) this.next = null; // unknown state: resync from chain next time
        throw e;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Force a resync from chain on next use (e.g. after "nonce too low"). */
  reset(): void {
    this.next = null;
  }
}

/** Throw from inside withNonce when nothing was broadcast, so the nonce is reused. */
export class NonceNotConsumed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonceNotConsumed";
  }
}
