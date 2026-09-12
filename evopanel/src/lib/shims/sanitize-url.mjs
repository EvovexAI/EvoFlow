// Resolved via vite alias `braintree-sanitize-url-dist` (pnpm-safe absolute path).
import sanitizeUrlModule from 'braintree-sanitize-url-dist'

export const sanitizeUrl =
  typeof sanitizeUrlModule?.sanitizeUrl === 'function'
    ? sanitizeUrlModule.sanitizeUrl
    : (url) => String(url ?? '')

export default { sanitizeUrl }
