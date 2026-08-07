// The providers a personal key can point at, so bringing your own key is a choice from
// a list rather than a URL you are expected to already know.
//
// Why this is a client-side list and not a server table: the server does not care who a
// base_url belongs to - it forwards to whatever OpenAI-compatible address it is given, and
// that is the whole reason `custom` can exist at all. Presets are a convenience for the
// person filling in the form, so they live next to the form.
//
// Endpoints are stable and safe to hard-code. MODEL NAMES ARE NOT - providers rename and
// retire them constantly, and this repo has already been bitten by exactly that: the
// operator's own FOLIO_AI_TEXT_MODELS listed two models the gateway had never heard of, so
// every AI call walked a fallback chain that was two-thirds dead. The suggestions below are
// a starting point, not a promise, which is why `loadModels` exists: asking the provider
// what it actually serves beats trusting a list baked in at build time.

export interface AiProvider {
  id: string;
  label: string;
  /** Empty means "this site's own gateway" - the server treats a key with no base_url
   *  as belonging to the deployment's configured endpoint. */
  baseUrl: string;
  /** A plausible starting point. Always editable, and never trusted over `loadModels`. */
  suggestedModels: string;
  /** Where the user goes to actually get a key. Nothing else in the dialog answers this. */
  keyUrl?: string;
  hint?: string;
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'site',
    label: "This site's AI (no endpoint needed)",
    baseUrl: '',
    suggestedModels: '',
    hint: 'Use a key issued for this app’s own gateway. Leave the endpoint alone.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModels: 'gpt-4o-mini, gpt-4o',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    suggestedModels: 'llama-3.3-70b-versatile, llama-3.1-8b-instant',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Fast and has a free tier, which makes it the usual pick for a student.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    suggestedModels: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    suggestedModels: 'mistral-medium-latest, mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    suggestedModels: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModels: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'One key, many providers behind it. Model names carry a vendor prefix.',
  },
  {
    id: 'custom',
    label: 'Something else…',
    baseUrl: '',
    suggestedModels: '',
    hint: 'Any OpenAI-compatible endpoint - a self-hosted gateway, Ollama, LM Studio, a university proxy.',
  },
];

export function providerById(id: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

/**
 * Work out which preset a saved key belongs to, so reopening the dialog shows the provider
 * the user picked rather than resetting to the top of the list.
 *
 * A stored base_url that matches no preset is genuinely custom - that is the case `custom`
 * exists for, and silently snapping it to the nearest preset would rewrite a working
 * endpoint into a different one.
 */
export function providerForBaseUrl(baseUrl: string | null | undefined): string {
  const url = (baseUrl ?? '').trim();
  if (!url) return 'site';
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase();
  const hit = AI_PROVIDERS.find((p) => p.baseUrl && norm(p.baseUrl) === norm(url));
  return hit ? hit.id : 'custom';
}
