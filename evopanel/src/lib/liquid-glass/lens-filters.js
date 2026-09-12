const SVG_ID = 'ef-glass-svg-filters'

export function ensureLensFilters() {
  if (document.getElementById(SVG_ID)) return
  const wrap = document.createElement('div')
  wrap.innerHTML = `
<svg id="${SVG_ID}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
  style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <filter id="ef-composer-lens" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" result="blur" />
      <feSpecularLighting in="blur" surfaceScale="3" specularConstant="0.75" specularExponent="28"
        lighting-color="white" result="spec">
        <fePointLight x="-40" y="-60" z="90" />
      </feSpecularLighting>
      <feComposite in="spec" in2="SourceAlpha" operator="in" result="spec-mask" />
      <feComposite in="SourceGraphic" in2="spec-mask" operator="arithmetic" k1="0" k2="1" k3="0.55" k4="0" />
    </filter>
  </defs>
</svg>`
  document.body?.appendChild(wrap.firstElementChild)
}
