export interface TodoPosition {
  x: number;
  y: number;
}
export function clampTodoPosition(
  position: TodoPosition | undefined,
  bounds: { width: number; height: number },
  panel: { width: number; height: number },
): TodoPosition {
  const maxX = Math.max(0, bounds.width - panel.width);
  const maxY = Math.max(0, bounds.height - panel.height);
  return {
    x: Math.max(0, Math.min(position?.x ?? maxX, maxX)),
    y: Math.max(0, Math.min(position?.y ?? 0, maxY)),
  };
}
