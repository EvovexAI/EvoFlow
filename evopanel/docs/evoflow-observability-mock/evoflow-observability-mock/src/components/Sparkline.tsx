export function Sparkline({ data, accent = 'blue' }: { data: number[]; accent?: string }) {
  const width = 220;
  const height = 46;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = Math.max(max - min, 1);
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 8) - 4;
      return `${x},${y}`;
    })
    .join(' ');
  const polygon = `0,${height} ${points} ${width},${height}`;

  return (
    <svg className={`sparkline sparkline-${accent}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={polygon} />
      <polyline points={points} />
    </svg>
  );
}
