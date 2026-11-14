export type KeyframeUploadMetadata = {
  sequence: number;
  provider_source_id: string;
  participant_id: string;
  participant_name?: string | null;
  captured_at: string;
  width: number;
  height: number;
  sha256: string;
};

export type KeyframeTransportStats = {
  uploaded: number;
  dropped_queue_full: number;
  dropped_opted_out: number;
  halted: boolean;
};

export type KeyframeTransportOptions = {
  maxQueueSize?: number;
  retryDelaysMs?: number[];
  requestTimeoutMs?: number;
  onHalted?: () => void;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class KeyframeTransport {
  private readonly endpoint: URL;
  private readonly maxQueueSize: number;
  private readonly retryDelaysMs: number[];
  private readonly requestTimeoutMs: number;
  private readonly onHalted?: () => void;
  private readonly queue: {metadata: KeyframeUploadMetadata; png: Uint8Array}[] = [];
  private pumping: Promise<void> | null = null;
  private uploadedCount = 0;
  private droppedQueueFullCount = 0;
  private droppedOptedOutCount = 0;
  private halted = false;
  private closing = false;

  constructor(
    apiUrl: string,
    attemptId: string,
    private readonly credential: string,
    private readonly workerId: string,
    options?: KeyframeTransportOptions,
  ) {
    this.endpoint = new URL(`/v1/attempts/${attemptId}/keyframes`, apiUrl);
    this.maxQueueSize = options?.maxQueueSize ?? 8;
    this.retryDelaysMs = options?.retryDelaysMs ?? [1000, 2000, 4000];
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
    this.onHalted = options?.onHalted;
  }

  stats(): KeyframeTransportStats {
    return {
      uploaded: this.uploadedCount,
      dropped_queue_full: this.droppedQueueFullCount,
      dropped_opted_out: this.droppedOptedOutCount,
      halted: this.halted,
    };
  }

  enqueue(metadata: KeyframeUploadMetadata, png: Uint8Array): void {
    if (this.halted || this.closing) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.droppedQueueFullCount += 1;
      return;
    }
    this.queue.push({metadata, png});
    this.ensurePump();
  }

  private ensurePump(): void {
    if (this.pumping) return;
    this.pumping = (async () => {
      while (this.queue.length > 0 && !this.halted) {
        const next = this.queue.shift()!;
        await this.uploadOne(next);
      }
    })().finally(() => {
      this.pumping = null;
      if (this.queue.length > 0 && !this.halted) {
        this.ensurePump();
      }
    });
  }

  private async uploadOne(item: {metadata: KeyframeUploadMetadata; png: Uint8Array}): Promise<void> {
    const metaHeader = Buffer.from(JSON.stringify(item.metadata), 'utf8').toString('base64url');
    const body = Buffer.from(item.png);
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (this.halted) return;
      let response: Response | undefined;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.credential}`,
            'X-Worker-ID': this.workerId,
            'Content-Type': 'image/png',
            'X-Wortlaut-Keyframe': metaHeader,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch {
        response = undefined;
      }

      if (response) {
        if (response.status === 200 || response.status === 201) {
          this.uploadedCount += 1;
          return;
        }
        if (!RETRYABLE_STATUS.has(response.status)) {
          let detail = '';
          try {
            const parsed = (await response.json()) as {detail?: unknown};
            if (typeof parsed?.detail === 'string') detail = parsed.detail;
          } catch {
            // non-JSON error body
          }
          if (response.status === 409 && detail === 'presenter_opted_out') {
            this.droppedOptedOutCount += 1;
            return;
          }
          if (
            (response.status === 409 &&
              (detail === 'keyframe_limit_reached' || detail === 'keyframes_disabled')) ||
            response.status === 507
          ) {
            this.halted = true;
            this.queue.length = 0;
            this.onHalted?.();
            return;
          }
          // Non-retryable 4xx error: discard without retry.
          return;
        }
      }

      if (attempt < this.retryDelaysMs.length && !this.halted) {
        const delayMs = this.retryDelaysMs[attempt];
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  async drain(timeoutMs = 10000): Promise<boolean> {
    this.closing = true;
    if (!this.pumping) return this.queue.length === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pumping,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.queue.length === 0 && this.pumping === null;
  }
}
