/** Render a QR as <img> using a local encoder (no third-party CDN). */
import QRCode from 'qrcode'

/**
 * @param {string} dataUrl
 * @param {{ size?: number, alt?: string }} [opts]
 * @returns {Promise<string>} HTML
 */
export async function qrImageHtml(dataUrl, opts = {}) {
  const raw = String(dataUrl || '').trim()
  const size = Math.max(120, Math.min(512, Number(opts.size) || 260))
  const alt = String(opts.alt || 'QR Code')
  if (!raw) {
    return `<p class="im-scan-error">未拿到二维码链接</p>`
  }
  const escAttr = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
  try {
    const dataUri = await QRCode.toDataURL(raw, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    })
    return (
      `<div class="im-scan-qr-inner">` +
      `<img class="im-scan-qr-img" src="${escAttr(dataUri)}" alt="${escAttr(alt)}" width="${size}" height="${size}">` +
      `<p class="im-scan-qr-fallback-link"><a href="${escAttr(raw)}" target="_blank" rel="noopener noreferrer">二维码不显示？点此打开链接</a></p>` +
      `</div>`
    )
  } catch (e) {
    return (
      `<div class="im-scan-qr-inner">` +
      `<p class="im-scan-error">本地二维码生成失败：${escAttr(e?.message || e)}</p>` +
      `<p class="im-scan-qr-fallback-link"><a href="${escAttr(raw)}" target="_blank" rel="noopener noreferrer">点此在浏览器打开</a></p>` +
      `</div>`
    )
  }
}

/** @deprecated No CDN fallbacks; kept for callers that still import it. */
export function ensureQrImgFallbackHandler() {
  /* no-op: QR images are generated locally as data URLs */
}
