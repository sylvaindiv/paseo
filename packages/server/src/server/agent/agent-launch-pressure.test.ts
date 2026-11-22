import { afterEach, expect, test, vi } from "vitest";
import { AgentLaunchPressure } from "./agent-launch-pressure.js";

afterEach(() => vi.useRealTimers());

test("waits for 30 seconds of normal pressure and checks again between launches", async () => {
  vi.useFakeTimers();
  let warning = true;
  const onPressure = vi.fn();
  const pressure = new AgentLaunchPressure(async () => warning, onPressure, Date.now);
  let finishFirst!: () => void;
  const startFirst = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  const startSecond = vi.fn(async () => {});
  const first = pressure.launch("first", startFirst);
  const second = pressure.launch("second", startSecond);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onPressure).toHaveBeenCalledTimes(1);
  expect(startFirst).not.toHaveBeenCalled();

  warning = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(startFirst).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(startFirst).toHaveBeenCalledTimes(1);
  expect(startSecond).not.toHaveBeenCalled();
  warning = true;
  finishFirst();
  await first;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(startSecond).not.toHaveBeenCalled();
  warning = false;
  await vi.advanceTimersByTimeAsync(31_000);
  await second;
  expect(startSecond).toHaveBeenCalledTimes(1);
});

test("cancels a queued launch before it can start", async () => {
  vi.useFakeTimers();
  const pressure = new AgentLaunchPressure(
    async () => true,
    () => {},
  );
  const start = vi.fn(async () => {});
  const result = expect(pressure.launch("canceled", start)).rejects.toThrow("canceled");
  pressure.cancel("canceled");
  await result;
  await vi.advanceTimersByTimeAsync(50_000);
  expect(start).not.toHaveBeenCalled();
});
