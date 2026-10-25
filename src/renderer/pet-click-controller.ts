interface Point { x: number; y: number }
interface Options {
  single(): void;
  double(): void;
  drag(dx: number, dy: number): void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  clear?: (timer: unknown) => void;
}

/** One gesture owner prevents pointer-up toggles from racing double-click and dragging. */
export class PetClickController {
  private press: { start: Point; last: Point; moved: boolean; second: boolean; ignored: boolean } | null = null;
  private pending: { point: Point; time: number; timer: unknown } | null = null;
  private suppressUntil = 0;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly clear: (timer: unknown) => void;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.clear = options.clear ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }
  get pressed(): boolean { return this.press !== null; }
  down(point: Point): void {
    let second = false;
    const pending = this.pending;
    if (pending) {
      second = this.now() - pending.time < 300 && Math.hypot(point.x - pending.point.x, point.y - pending.point.y) <= 4;
      this.clear(pending.timer); this.pending = null;
      if (!second) this.options.single();
    }
    this.press = { start: point, last: point, moved: false, second, ignored: this.now() < this.suppressUntil };
  }
  move(point: Point): void {
    const press = this.press;
    if (!press) return;
    if (!press.moved && Math.hypot(point.x - press.start.x, point.y - press.start.y) <= 4) return;
    const previous = press.moved ? press.last : press.start;
    press.moved = true; press.last = point;
    this.options.drag(point.x - previous.x, point.y - previous.y);
  }
  up(point: Point): void {
    this.move(point);
    const press = this.press; this.press = null;
    if (!press || press.moved || press.ignored) return;
    if (press.second) { this.suppressUntil = this.now() + 300; this.options.double(); return; }
    const pending = { point, time: this.now(), timer: undefined as unknown };
    pending.timer = this.schedule(() => { if (this.pending !== pending) return; this.pending = null; this.options.single(); }, 300);
    this.pending = pending;
  }
  cancel(): void {
    if (this.pending) this.clear(this.pending.timer);
    this.pending = null; this.press = null; this.suppressUntil = 0;
  }
}
