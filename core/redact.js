/* Redaction for audit logs and exports: secrets are removed, personal data is masked. */
const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|session|private[_-]?key|credential)/i;
const PATTERNS = [
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\btb_(viewer|agent|admin|[a-z0-9]+)_[A-Za-z0-9]{6,}\b/g, '[REDACTED_TOKEN]'],
  [/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[REDACTED_CARD]' : m)],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
  [/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2'],
  [/(?:\+\d{1,2}[-. ]?)?\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, (m) => '***-' + m.replace(/\D/g, '').slice(-4)]
];
function luhn(d) { if (d.length < 13) return false; let s = 0; let alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
export function redactString(s) { let out = String(s); for (const [re, rep] of PATTERNS) out = out.replace(re, rep); return out; }
export function redact(value, depth) {
  const d = depth || 0;
  if (d > 8) return '[…]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, d + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : k === 'salary_band' ? '[REDACTED]' : redact(v, d + 1);
    return out;
  }
  return value;
}
