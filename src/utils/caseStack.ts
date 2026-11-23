/** 下一批可浏览的案例在后排，当前案例始终位于最下面。 */
export function getCaseStackPositions(count: number, active: number): number[] {
  if (count <= 0) return [];
  const current = ((active % count) + count) % count;
  return [
    ...Array.from({ length: Math.min(4, count - 1) }, (_, offset) => (current + offset + 1) % count),
    current,
  ];
}
