// Helpers for the OTLP/HTTP JSON encoding (ExportLogsServiceRequest).
// Values may arrive as stringValue, intValue (string or number), boolValue,
// doubleValue, arrayValue or kvlistValue; adapters only ever see plain JS
// values through `attributes()`.

export function anyValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(anyValue);
  if ('kvlistValue' in value) return attributes(value.kvlistValue.values);
  return undefined;
}

/** [{key, value}] → { key: plainValue } */
export function attributes(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (item && typeof item.key === 'string') out[item.key] = anyValue(item.value);
  }
  return out;
}

/** Yield { resource, scope, record, attrs, time } for every log record. */
export function* logRecords(request) {
  for (const resourceLogs of Array.isArray(request?.resourceLogs) ? request.resourceLogs : []) {
    const resource = attributes(resourceLogs?.resource?.attributes);
    for (const scopeLogs of Array.isArray(resourceLogs?.scopeLogs) ? resourceLogs.scopeLogs : []) {
      const scope = scopeLogs?.scope?.name;
      for (const record of Array.isArray(scopeLogs?.logRecords) ? scopeLogs.logRecords : []) {
        const attrs = attributes(record?.attributes);
        yield { resource, scope, attrs, time: recordTime(record, attrs), body: anyValue(record?.body) };
      }
    }
  }
}

function recordTime(record, attrs) {
  const nanos = record?.timeUnixNano ?? record?.observedTimeUnixNano;
  if (nanos !== undefined && nanos !== '0' && nanos !== 0) {
    const ms = Number(BigInt(String(nanos)) / 1_000_000n);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  const stamp = attrs['event.timestamp'];
  if (typeof stamp === 'string' && !Number.isNaN(Date.parse(stamp))) return new Date(stamp).toISOString();
  return new Date().toISOString();
}

export function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return undefined;
}

export function toNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
