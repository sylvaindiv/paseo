import { expect, test } from "vitest";
import { clampTodoPosition } from "./position";
test("opens top right and constrains dragged panels after workspace resizing", () => {
  expect(
    clampTodoPosition(undefined, { width: 1000, height: 600 }, { width: 360, height: 300 }),
  ).toEqual({ x: 640, y: 0 });
  expect(
    clampTodoPosition({ x: 999, y: 999 }, { width: 700, height: 400 }, { width: 360, height: 300 }),
  ).toEqual({ x: 340, y: 100 });
  expect(
    clampTodoPosition({ x: -10, y: -10 }, { width: 200, height: 100 }, { width: 360, height: 300 }),
  ).toEqual({ x: 0, y: 0 });
});
