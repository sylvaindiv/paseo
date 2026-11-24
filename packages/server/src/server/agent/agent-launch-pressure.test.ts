import { afterEach, expect, test, vi } from "vitest";
import { AgentLaunchPressure, type MacMemoryPressure } from "./agent-launch-pressure.js";

afterEach(() => vi.useRealTimers());

test("starts immediately under persistent warning and serializes the next launch", async () => {
  vi.useFakeTimers();
  const onPressure = vi.fn();
  const read = vi.fn(async () => "warning" as const);
  const pressure = new AgentLaunchPressure(read, onPressure);
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
  await vi.advanceTimersByTimeAsync(0);
  expect(startFirst).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(onPressure).toHaveBeenCalledTimes(1);
  expect(startSecond).not.toHaveBeenCalled();

  read.mockClear();
  finishFirst();
  await first;
  await second;
  expect(read).toHaveBeenCalled();
  expect(startSecond).toHaveBeenCalledTimes(1);
});

test.each(["warning", "normal"] as const)(
  "keeps FIFO order under critical pressure and resumes on the next %s reading",
  async (recovery) => {
    vi.useFakeTimers();
    let level: MacMemoryPressure | null = "critical";
    const pressure = new AgentLaunchPressure(async () => level, vi.fn());
    const order: string[] = [];
    const waiting = vi.fn();
    const first = pressure.launch(
      "first",
      async () => {
        order.push("first");
      },
      waiting,
    );
    const second = pressure.launch(
      "second",
      async () => {
        order.push("second");
      },
      waiting,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(waiting).toHaveBeenCalledTimes(2);
    level = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual([]);
    level = recovery;
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(waiting).toHaveBeenCalledTimes(2);
  },
);

test.each(["normal", null] as const)("admits concurrent launches at %s", async (level) => {
  vi.useFakeTimers();
  const pressure = new AgentLaunchPressure(async () => level, vi.fn());
  const start = vi.fn(async () => new Promise<void>(() => {}));
  void pressure.launch("first", start);
  void pressure.launch("second", start);
  await vi.advanceTimersByTimeAsync(0);
  expect(start).toHaveBeenCalledTimes(2);
});

test("checks again after starting an agent before admitting the next", async () => {
  vi.useFakeTimers();
  let level: MacMemoryPressure = "warning";
  const pressure = new AgentLaunchPressure(async () => level, vi.fn());
  const first = pressure.launch("first", async () => {
    level = "critical";
  });
  const startSecond = vi.fn(async () => {});
  const second = pressure.launch("second", startSecond);
  await first;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(startSecond).not.toHaveBeenCalled();
  level = "warning";
  await vi.advanceTimersByTimeAsync(1_000);
  await second;
  expect(startSecond).toHaveBeenCalledTimes(1);
});

test("cancels a queued launch before it can start", async () => {
  vi.useFakeTimers();
  let level: MacMemoryPressure = "critical";
  const pressure = new AgentLaunchPressure(async () => level, vi.fn());
  const start = vi.fn(async () => {});
  const result = expect(pressure.launch("canceled", start)).rejects.toThrow("canceled");
  await vi.advanceTimersByTimeAsync(0);
  pressure.cancel("canceled");
  await result;
  level = "normal";
  await vi.advanceTimersByTimeAsync(1_000);
  expect(start).not.toHaveBeenCalled();
  await pressure.launch("next", start);
  expect(start).toHaveBeenCalledTimes(1);
});
