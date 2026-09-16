/* Optional cost cross-check from Claude Code's OpenTelemetry export.
   Claude Code emits `claude_code.cost.usage` (USD) and `claude_code.token.usage` counters with
   `session.id` and `model` attributes when CLAUDE_CODE_ENABLE_TELEMETRY=1. `tally otel` runs a loopback
   OTLP/HTTP JSON receiver and appends every data point to ~/.tally/otel/metrics.jsonl; the Judge sums the
   points for its session and shows the delta against the transcript-derived cost. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tallyHome, appendLine, ensureDir } from '../paths.js';

export interface OtelPoint {
  ts: string;
  name: string;
  value: number;
  attrs: Record<string, string>;
}

export function otelFile(): string {
  return path.join(tallyHome(), 'otel', 'metrics.jsonl');
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface DataPoint {
  asDouble?: number;
  asInt?: string | number;
  attributes?: KeyValue[];
  timeUnixNano?: string | number;
}
interface Metric {
  name?: string;
  sum?: { dataPoints?: DataPoint[]; aggregationTemporality?: number | string; isMonotonic?: boolean };
  gauge?: { dataPoints?: DataPoint[] };
}
interface OtlpMetricsBody {
  resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: Metric[] }> }>;
}

function attrValue(v: AnyValue | undefined): string {
  if (!v) return '';
  if (v.stringValue !== undefined) return String(v.stringValue);
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return '';
}

export function parseOtlpMetrics(body: unknown, now = new Date()): OtelPoint[] {
  const out: OtelPoint[] = [];
  const b = (body ?? {}) as OtlpMetricsBody;
  for (const rm of b.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        if (!m.name || !m.name.startsWith('claude_code.')) continue;
        const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
        for (const p of points) {
          const value = p.asDouble !== undefined ? Number(p.asDouble) : p.asInt !== undefined ? Number(p.asInt) : NaN;
          if (!Number.isFinite(value)) continue;
          const attrs: Record<string, string> = {};
          for (const kv of p.attributes ?? []) attrs[kv.key] = attrValue(kv.value);
          const ts = p.timeUnixNano ? new Date(Number(BigInt(String(p.timeUnixNano)) / 1000000n)).toISOString() : now.toISOString();
          out.push({ ts, name: m.name, value, attrs });
        }
      }
    }
  }
  return out;
}

export function recordOtelPoints(points: OtelPoint[], file = otelFile()): void {
  if (!points.length) return;
  ensureDir(path.dirname(file));
  for (const p of points) appendLine(file, JSON.stringify(p));
}

export function readOtelPoints(file = otelFile()): OtelPoint[] {
  if (!fs.existsSync(file)) return [];
  const out: OtelPoint[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OtelPoint);
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface OtelSessionCost {
  available: boolean;
  total_usd: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  points: number;
  by_model: Record<string, number>;
}

/* Sums delta-temporality counters for one session. Cumulative exporters would double count; the setup
   instructions require OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta (Claude Code's default). */
export function otelCostForSession(sessionId: string, points = readOtelPoints()): OtelSessionCost {
  const mine = points.filter((p) => p.attrs['session.id'] === sessionId);
  const r: OtelSessionCost = { available: mine.length > 0, total_usd: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, points: mine.length, by_model: {} };
  for (const p of mine) {
    if (p.name === 'claude_code.cost.usage') {
      r.total_usd += p.value;
      const model = p.attrs.model ?? 'unknown';
      r.by_model[model] = (r.by_model[model] ?? 0) + p.value;
    } else if (p.name === 'claude_code.token.usage') {
      const type = (p.attrs.type ?? '').toLowerCase();
      if (type === 'input') r.tokens.input += p.value;
      else if (type === 'output') r.tokens.output += p.value;
      else if (type === 'cacheread') r.tokens.cache_read += p.value;
      else if (type === 'cachecreation') r.tokens.cache_write += p.value;
    }
  }
  r.total_usd = Math.round(r.total_usd * 1e6) / 1e6;
  return r;
}

export function otelSetupEnv(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  };
}

export function startOtelReceiver(opts: { port: number; file?: string; onPoints?: (p: OtelPoint[]) => void }): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        if (/\/v1\/metrics/.test(req.url ?? '')) {
          try {
            const points = parseOtlpMetrics(JSON.parse(body));
            recordOtelPoints(points, opts.file);
            opts.onPoints?.(points);
          } catch {
            /* non-JSON (protobuf) payloads are ignored; setup uses http/json */
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : opts.port });
    });
  });
}
