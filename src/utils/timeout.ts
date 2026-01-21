export class TimeoutError<T = unknown> extends Error {
  payload?: T;
  seconds: number;
  label: string;
  constructor(seconds: number, label = "command", payload?: T) {
    super(`${label} timeout occurred after ${seconds} seconds`);
    this.name = "TimeoutError";
    this.payload = payload;
    this.seconds = seconds;
    this.label = label;
  }
}

/**
 * Wrap an async operation with a timeout. If the operation does not settle
 * within the given number of seconds, reject with a TimeoutError.
 *
 * Options:
 * - onTimeout: optional callback invoked when the timeout fires. The return
 *   value will be attached to TimeoutError as `payload`.
 */
export function withTimeout<T, P = unknown>(
  work: Promise<T>,
  seconds: number,
  label = "command",
  opts?: { onTimeout?: () => P | Promise<P> },
): Promise<T> {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("seconds must be a non‑negative finite number");
  }
  const ms = Math.floor(seconds * 1000);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const payload = await opts?.onTimeout?.()
          reject(new TimeoutError<P>(seconds, label, payload))
        } catch {
          reject(new TimeoutError(seconds, label))
        }
      })()
    }, ms)

    let settled = false;
    work
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}
