function nonNegativeNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

export function createTransferResult({
  method,
  bytesTotal = 0,
  bytesTransferred = 0,
  resumed = false,
  resumeSupported = false,
  verifiedSha256 = false,
  durationMs = 0,
} = {}) {
  if (typeof method !== 'string' || method.length === 0) {
    throw new TypeError('method must be a non-empty string');
  }
  if (typeof resumed !== 'boolean') throw new TypeError('resumed must be a boolean');
  if (typeof resumeSupported !== 'boolean') throw new TypeError('resumeSupported must be a boolean');
  if (typeof verifiedSha256 !== 'boolean') throw new TypeError('verifiedSha256 must be a boolean');

  return {
    method,
    bytes_total: nonNegativeNumber(bytesTotal, 'bytesTotal'),
    bytes_transferred: nonNegativeNumber(bytesTransferred, 'bytesTransferred'),
    resumed,
    resume_supported: resumeSupported,
    verified_sha256: verifiedSha256,
    duration_ms: nonNegativeNumber(durationMs, 'durationMs'),
  };
}
