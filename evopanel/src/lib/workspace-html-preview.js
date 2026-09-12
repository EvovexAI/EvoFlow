/** Compatibility shims injected into agent HTML before iframe srcDoc preview. */

const PREVIEW_HEAD_SHIM = `<script>(function(){try{window.tailwind=window.tailwind||{};if(!window.tailwind.config)window.tailwind.config={plugins:[]};}catch(e){}})();</script>`

/**
 * Prepare HTML for sandboxed iframe preview (srcDoc).
 * - Ensures tailwind.config exists before inline config scripts (v3-style HTML + v4 CDN).
 * @param {string} html
 * @returns {string}
 */
export function prepareHtmlSrcDocForPreview(html) {
  const raw = String(html || '')
  if (!raw.trim()) return raw
  if (/<meta\s[^>]*data-evf-preview-shim/i.test(raw)) return raw

  const shim = `${PREVIEW_HEAD_SHIM}<meta data-evf-preview-shim="1" />`

  if (/<head[\s>]/i.test(raw)) {
    return raw.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${shim}`)
  }
  if (/<html[\s>]/i.test(raw)) {
    return raw.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${shim}</head>`)
  }
  return `${shim}${raw}`
}
