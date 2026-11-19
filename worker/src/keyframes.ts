export const LUMA_W = 64;
export const LUMA_H = 36;
export const LUMA_PIXELS = LUMA_W * LUMA_H;
export const BLOCKS_X = 16;
export const BLOCKS_Y = 9;
export const BLOCK_SIZE = 4;
export const MIN_LUMA_STDDEV = 4.0;
export const GLOBAL_MAD_THRESHOLD = 12.0;
export const BLOCK_DELTA_THRESHOLD = 22.0;
export const MIN_CHANGED_BLOCKS = 6;
export const KEYFRAME_SETTLE_TICKS = 3;
export const KEYFRAME_SUBSEQUENT_SETTLE_TICKS = 4;
export const KEYFRAME_COOLDOWN_MS = 5000;
export const RECENT_KEYFRAME_HISTORY = 5;
export const MAX_KEYFRAMES_PER_RECORDING = 60;
export const MAX_EXPORT_W = 1280;
export const MAX_EXPORT_H = 720;
export const MAX_KEYFRAME_BYTES = 1_572_864;

export type KeyframeCapability = 'disabled' | 'unsupported' | 'unverified' | 'active';

export type KeyframeDiagnostics = {
  capability: KeyframeCapability;
  active_share: boolean;
  evaluated_ticks: number;
  emitted: number;
  uploaded: number;
  dropped_unverified: number;
  dropped_opted_out: number;
  dropped_queue_full: number;
};

export type KeyframeMetadata = {
  sequence: number;
  provider_source_id: string;
  participant_id: string;
  participant_name: string | null;
  captured_at: string;
  width: number;
  height: number;
  sha256: string;
};

export type AdmittedShareSource = {
  element: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  provider_source_id: string;
  participant_id: string;
  participant_name: string | null;
};

export type SamplerClockOptions = {
  nowMs?: () => number;
  nowUtc?: () => string;
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
};

export function computeLumaGridFromRgba(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(LUMA_PIXELS);
  for (let i = 0, p = 0; i < LUMA_PIXELS && p + 2 < rgba.length; i++, p += 4) {
    out[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
  }
  return out;
}

export function computeLumaStddev(grid: Uint8Array): number {
  if (!grid.length) return 0;
  let sum = 0;
  for (let i = 0; i < grid.length; i++) sum += grid[i];
  const mean = sum / grid.length;
  let sq = 0;
  for (let i = 0; i < grid.length; i++) {
    const d = grid[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / grid.length);
}

export function gridsDiffer(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== LUMA_PIXELS || b.length !== LUMA_PIXELS) return true;
  let absSum = 0;
  for (let i = 0; i < LUMA_PIXELS; i++) {
    absSum += Math.abs(a[i] - b[i]);
  }
  if (absSum / LUMA_PIXELS >= GLOBAL_MAD_THRESHOLD) return true;

  let changedBlocks = 0;
  for (let by = 0; by < BLOCKS_Y; by++) {
    const y0 = by * BLOCK_SIZE;
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      const x0 = bx * BLOCK_SIZE;
      let sumA = 0;
      let sumB = 0;
      for (let dy = 0; dy < BLOCK_SIZE; dy++) {
        const row = (y0 + dy) * LUMA_W + x0;
        for (let dx = 0; dx < BLOCK_SIZE; dx++) {
          sumA += a[row + dx];
          sumB += b[row + dx];
        }
      }
      const delta = Math.abs(sumA - sumB) / (BLOCK_SIZE * BLOCK_SIZE);
      if (delta >= BLOCK_DELTA_THRESHOLD) {
        changedBlocks += 1;
        if (changedBlocks >= MIN_CHANGED_BLOCKS) return true;
      }
    }
  }
  return false;
}

export function computeExportDimensions(srcWidth: number, srcHeight: number): {width: number; height: number} {
  const w = Math.max(1, Math.round(srcWidth));
  const h = Math.max(1, Math.round(srcHeight));
  if (w <= MAX_EXPORT_W && h <= MAX_EXPORT_H) {
    return {width: w, height: h};
  }
  const scale = Math.min(MAX_EXPORT_W / w, MAX_EXPORT_H / h);
  return {
    width: Math.max(1, Math.min(MAX_EXPORT_W, Math.round(w * scale))),
    height: Math.max(1, Math.min(MAX_EXPORT_H, Math.round(h * scale))),
  };
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(raw);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export class ScreenShareKeyframeSampler {
  private lumaCanvas: HTMLCanvasElement | null = null;
  private lumaCtx: CanvasRenderingContext2D | null = null;
  private exportCanvas: HTMLCanvasElement | null = null;
  private exportCtx: CanvasRenderingContext2D | null = null;
  private lastCommittedGrid: Uint8Array | null = null;
  private lastCommittedSourceKey: string | null = null;
  private recentCommittedGrids: Uint8Array[] = [];
  private candidateGrid: Uint8Array | null = null;
  private candidateSourceKey: string | null = null;
  private candidateOnsetUtc: string | null = null;
  private candidateOnsetMs: number | null = null;
  private stableTicks = 0;
  private lastCommittedAtMs: number | null = null;
  private nextSequence = 0;
  private emittedCount = 0;
  private evaluatedTicksCount = 0;
  private halted = false;
  private busy = false;
  private readonly nowMs: () => number;
  private readonly nowUtc: () => string;
  private readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;

  constructor(
    private readonly onKeyframe: (
      metadata: KeyframeMetadata,
      base64Png: string,
      byteLength: number,
    ) => void,
    options?: SamplerClockOptions,
  ) {
    this.nowMs = options?.nowMs ?? (() => performance.now());
    this.nowUtc = options?.nowUtc ?? (() => new Date().toISOString());
    this.createCanvas = options?.createCanvas ?? ((w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    });
  }

  get evaluatedTicks(): number {
    return this.evaluatedTicksCount;
  }

  get emitted(): number {
    return this.emittedCount;
  }

  get isHalted(): boolean {
    return this.halted;
  }

  halt(): void {
    this.halted = true;
    this.resetCandidate();
  }

  resetCandidate(): void {
    this.candidateGrid = null;
    this.candidateSourceKey = null;
    this.candidateOnsetUtc = null;
    this.candidateOnsetMs = null;
    this.stableTicks = 0;
  }

  async tick(source: AdmittedShareSource | null): Promise<boolean> {
    if (this.halted || this.emittedCount >= MAX_KEYFRAMES_PER_RECORDING) {
      return false;
    }
    if (!source) {
      this.resetCandidate();
      return false;
    }
    const srcW = source.sourceWidth;
    const srcH = source.sourceHeight;
    if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW < 2 || srcH < 2) {
      return false;
    }
    if (this.busy) {
      return false;
    }

    this.evaluatedTicksCount += 1;

    if (!this.lumaCanvas) {
      this.lumaCanvas = this.createCanvas(LUMA_W, LUMA_H);
      this.lumaCtx = this.lumaCanvas.getContext('2d', {willReadFrequently: true});
    }
    if (!this.lumaCtx) {
      return false;
    }

    let rgba: Uint8ClampedArray;
    try {
      this.lumaCtx.clearRect(0, 0, LUMA_W, LUMA_H);
      this.lumaCtx.drawImage(source.element, 0, 0, LUMA_W, LUMA_H);
      rgba = this.lumaCtx.getImageData(0, 0, LUMA_W, LUMA_H).data;
    } catch {
      this.resetCandidate();
      return false;
    }

    const grid = computeLumaGridFromRgba(rgba);
    if (computeLumaStddev(grid) < MIN_LUMA_STDDEV) {
      this.resetCandidate();
      return false;
    }

    const sourceKey = `${source.participant_id}\0${source.provider_source_id}`;
    if (
      this.lastCommittedSourceKey === sourceKey &&
      ((this.lastCommittedGrid && !gridsDiffer(grid, this.lastCommittedGrid)) ||
        this.recentCommittedGrids.some((prev) => !gridsDiffer(grid, prev)))
    ) {
      this.lastCommittedGrid = grid;
      this.resetCandidate();
      return false;
    }

    const tickNowMs = this.nowMs();
    if (
      this.candidateGrid &&
      this.candidateSourceKey === sourceKey &&
      !gridsDiffer(grid, this.candidateGrid)
    ) {
      this.stableTicks += 1;
    } else {
      this.candidateGrid = grid;
      this.candidateSourceKey = sourceKey;
      this.candidateOnsetUtc = this.nowUtc();
      this.candidateOnsetMs = tickNowMs;
      this.stableTicks = 1;
    }

    const requiredSettleTicks =
      this.lastCommittedSourceKey === sourceKey
        ? KEYFRAME_SUBSEQUENT_SETTLE_TICKS
        : KEYFRAME_SETTLE_TICKS;
    if (this.stableTicks < requiredSettleTicks) {
      return false;
    }

    if (this.lastCommittedAtMs !== null && tickNowMs - this.lastCommittedAtMs < KEYFRAME_COOLDOWN_MS) {
      return false;
    }

    this.busy = true;
    try {
      const {width, height} = computeExportDimensions(srcW, srcH);
      if (!this.exportCanvas) {
        this.exportCanvas = this.createCanvas(width, height);
        this.exportCtx = this.exportCanvas.getContext('2d');
      } else if (this.exportCanvas.width !== width || this.exportCanvas.height !== height) {
        this.exportCanvas.width = width;
        this.exportCanvas.height = height;
        this.exportCtx = this.exportCanvas.getContext('2d');
      }
      if (!this.exportCtx) return false;

      this.exportCtx.clearRect(0, 0, width, height);
      this.exportCtx.drawImage(source.element, 0, 0, width, height);
      const exportCanvas = this.exportCanvas;
      const blob = await new Promise<Blob | null>((resolve) => {
        exportCanvas.toBlob((b) => resolve(b), 'image/png');
      });
      if (!blob || blob.size < 8) return false;
      if (blob.size > MAX_KEYFRAME_BYTES) {
        if (this.lastCommittedSourceKey !== sourceKey) {
          this.recentCommittedGrids = [];
        }
        this.lastCommittedGrid = grid;
        this.lastCommittedSourceKey = sourceKey;
        this.resetCandidate();
        return false;
      }

      const pngBytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = await sha256Hex(pngBytes);
      const encoded = encodeBytesBase64(pngBytes);
      const heldByCooldown =
        this.lastCommittedAtMs !== null &&
        this.candidateOnsetMs !== null &&
        this.candidateOnsetMs - this.lastCommittedAtMs < KEYFRAME_COOLDOWN_MS;
      const capturedAt = heldByCooldown ? this.nowUtc() : (this.candidateOnsetUtc ?? this.nowUtc());
      const sequence = this.nextSequence++;
      this.emittedCount += 1;
      if (this.lastCommittedSourceKey !== sourceKey) {
        this.recentCommittedGrids = [grid];
      } else {
        this.recentCommittedGrids.push(grid);
        if (this.recentCommittedGrids.length > RECENT_KEYFRAME_HISTORY) {
          this.recentCommittedGrids.shift();
        }
      }
      this.lastCommittedGrid = grid;
      this.lastCommittedSourceKey = sourceKey;
      this.lastCommittedAtMs = tickNowMs;
      this.resetCandidate();

      if (this.emittedCount >= MAX_KEYFRAMES_PER_RECORDING) {
        this.halted = true;
      }

      this.onKeyframe(
        {
          sequence,
          provider_source_id: source.provider_source_id,
          participant_id: source.participant_id,
          participant_name: source.participant_name,
          captured_at: capturedAt,
          width,
          height,
          sha256,
        },
        encoded,
        pngBytes.byteLength,
      );
      return true;
    } finally {
      this.busy = false;
    }
  }
}

export type EmptyRoomEvaluationInput = {
  nowMs: number;
  emptySinceMs: number | undefined;
  configuredTimeoutSeconds?: number;
  currentDomParticipants: number;
  maxDomParticipants: number;
  streams: number;
  activeSamples: number;
  lastActiveSamples: number;
  rtpAdvanced: boolean;
  activeShare: boolean;
  paused?: boolean;
};

export type EmptyRoomEvaluationResult = {
  shouldStop: boolean;
  emptySinceMs: number | undefined;
  lastActiveSamples: number;
  maxDomParticipants: number;
};

export function shouldStopForEmptyRoom(input: EmptyRoomEvaluationInput): EmptyRoomEvaluationResult {
  const maxDomParticipants = Math.max(input.maxDomParticipants, input.currentDomParticipants);
  const domEmptied = maxDomParticipants >= 1 && input.currentDomParticipants === 0;
  const audioAdvanced = input.activeSamples > input.lastActiveSamples && input.streams > 0;
  const rtpActive = !domEmptied && input.rtpAdvanced;
  const shareActive = !domEmptied && input.activeShare === true;
  const pauseActive = !domEmptied && input.paused === true;

  if (audioAdvanced || rtpActive || shareActive || pauseActive) {
    return {
      shouldStop: false,
      emptySinceMs: undefined,
      lastActiveSamples: audioAdvanced ? input.activeSamples : input.lastActiveSamples,
      maxDomParticipants,
    };
  }

  const emptySinceMs = input.emptySinceMs ?? input.nowMs;
  const configuredTimeout = input.configuredTimeoutSeconds ?? 300;
  const emptyTimeoutSeconds =
    maxDomParticipants >= 1 && input.currentDomParticipants === 0
      ? Math.min(configuredTimeout, 15)
      : maxDomParticipants >= 2 && input.currentDomParticipants <= 1
        ? Math.min(configuredTimeout, 60)
        : input.currentDomParticipants >= 2
          ? Math.max(configuredTimeout * 6, 1800)
          : configuredTimeout;

  return {
    shouldStop: input.nowMs - emptySinceMs >= emptyTimeoutSeconds * 1000,
    emptySinceMs,
    lastActiveSamples: input.lastActiveSamples,
    maxDomParticipants,
  };
}
