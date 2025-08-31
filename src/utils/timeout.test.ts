import { describe, it, expect } from "bun:test";
import { withTimeout, TimeoutError } from "./timeout";

function delay<T>(ms: number, value: T, shouldReject = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      if (shouldReject) reject(value as unknown as Error);
      else resolve(value);
    }, ms);
  });
}

describe("withTimeout", () => {
  it("resolves before timeout", async () => {
    const result = await withTimeout(delay(50, 42), 0.2);
    expect(result).toBe(42);
  });

  it("rejects underlying error before timeout", async () => {
    const err = new Error("boom");
    await expect(withTimeout(Promise.reject(err), 1)).rejects.toBe(err);
  });

  it("times out when work takes too long", async () => {
    const seconds = 0.05; // 50ms
    await expect(withTimeout(delay(100, 1), seconds)).rejects.toEqual(
      new TimeoutError(seconds, "command"),
    );
  });

  it("uses custom label in message", async () => {
    const seconds = 0.01;
    try {
      await withTimeout(delay(50, 1), seconds, "exec");
      throw new Error("expected timeout");
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      const msg = (e as Error).message;
      expect(msg).toBe(`exec timeout occurred after ${seconds} seconds`);
    }
  });

  it("invokes onTimeout and attaches payload", async () => {
    const seconds = 0.02;
    const payload = { stdout: "partial out", stderr: "partial err" };
    try {
      await withTimeout(delay(100, 1), seconds, "command", {
        onTimeout: async () => payload,
      });
      throw new Error("expected timeout");
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      const te = e as TimeoutError<typeof payload>;
      expect(te.payload).toEqual(payload);
      expect(te.seconds).toBe(seconds);
      expect(te.label).toBe("command");
    }
  });

  it("validates seconds", () => {
    expect(() => withTimeout(Promise.resolve(1), -1)).toThrow();
    expect(() => withTimeout(Promise.resolve(1), Number.NaN)).toThrow();
  });
});
