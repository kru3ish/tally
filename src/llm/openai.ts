/* A local or self-hosted model behind the OpenAI-compatible chat API (Ollama, vLLM, LM Studio, llama.cpp server):
   air-gapped judging and coaching with no outbound traffic. Structured output is requested as JSON in the prompt and
   parsed leniently. Cost is zero unless config gives a price. */
import { recordTallySpend, type LlmClient, type LlmRequest, type LlmResult } from './client.js';
import type { Usage } from '../cost/pricing.js';
import { log } from '../paths.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  session?: string;
  usdPerMillionInput?: number;
  usdPerMillionOutput?: number;
  timeoutMs?: number;
}

export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fence?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error(`model returned no JSON object: ${text.slice(0, 200)}`);
  }
}

export class OpenAICompatible implements LlmClient {
  constructor(private readonly opts: OpenAICompatibleOptions) {}

  async complete<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const started = Date.now();
    const url = this.opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: req.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `${req.system}\n\nRespond with a single JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(req.schema)}` },
        { role: 'user', content: req.prompt },
      ],
      response_format: { type: 'json_object' },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? this.opts.timeoutMs ?? 240000);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) }, body: JSON.stringify(body), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
    const content = json.choices?.[0]?.message?.content ?? '';
    const data = extractJson(content) as T;
    const usage: Usage = { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
    const cost_usd = (usage.input * (this.opts.usdPerMillionInput ?? 0) + usage.output * (this.opts.usdPerMillionOutput ?? 0)) / 1e6;
    const model = `local:${json.model ?? req.model}`;
    recordTallySpend({ kind: req.tier ? `${req.kind}:tier${req.tier}` : req.kind, model, cost_usd, usage, session: this.opts.session });
    log(`llm(local) ${req.kind}${req.tier ? ':tier' + req.tier : ''} model=${model} tokens=${usage.input}+${usage.output} ms=${Date.now() - started}`);
    return { data, usage, cost_usd, model, duration_ms: Date.now() - started };
  }
}
