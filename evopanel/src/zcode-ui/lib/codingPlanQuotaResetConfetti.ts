const PARTICLE_COUNT = 10;
const PARTICLE_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-brand)",
  "var(--color-warning)",
] as const;

export function burstCodingPlanQuotaResetConfetti(origin: HTMLElement): void {
  const ownerDocument = origin.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const rect = origin.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;

  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    const particle = ownerDocument.createElement("span");
    const angle = (-160 + (140 * index) / (PARTICLE_COUNT - 1)) * (Math.PI / 180);
    const distance = 36 + Math.random() * 28;
    const offsetX = Math.cos(angle) * distance;
    const offsetY = Math.sin(angle) * distance;

    Object.assign(particle.style, {
      position: "fixed",
      zIndex: "100",
      left: `${originX}px`,
      top: `${originY}px`,
      width: `${2 + (index % 2)}px`,
      height: `${3 + (index % 3)}px`,
      borderRadius: "1px",
      backgroundColor: PARTICLE_COLORS[index % PARTICLE_COLORS.length],
      pointerEvents: "none",
    });
    ownerDocument.body.append(particle);

    const animation = particle.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
        {
          transform: `translate(calc(-50% + ${offsetX * 0.8}px), calc(-50% + ${offsetY}px)) rotate(${180 + index * 23}deg)`,
          opacity: 1,
          offset: 0.65,
        },
        {
          transform: `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY + 32}px)) rotate(${360 + index * 31}deg)`,
          opacity: 0,
        },
      ],
      {
        duration: 420 + (index % 3) * 35,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    );
    void animation.finished.then(
      () => particle.remove(),
      () => particle.remove(),
    );
  }
}
