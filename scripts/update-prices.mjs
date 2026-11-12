// Builds src/pricing/prices.json from LiteLLM's model price table (MIT).
// Keeps only direct-provider entries and the fields burnlint uses.
// Usage: node scripts/update-prices.mjs [path-to-litellm-json]
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const KEEP_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "xai",
  "mistral",
  "dashscope",
  "moonshot",
  "zai",
]);

async function load() {
  const local = process.argv[2];
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.json();
}

const perM = (v) => (typeof v === "number" ? +(v * 1e6).toPrecision(6) : null);

const raw = await load();
const models = {};
for (const [id, v] of Object.entries(raw)) {
  if (!v || typeof v !== "object") continue;
  if (!KEEP_PROVIDERS.has(v.litellm_provider)) continue;
  if (v.mode && v.mode !== "chat" && v.mode !== "responses") continue;
  if (typeof v.input_cost_per_token !== "number") continue;
  const key = id.includes("/") ? id.split("/").slice(1).join("/") : id;
  if (models[key] && id.includes("/")) continue; // prefer the bare id
  models[key] = {
    provider: v.litellm_provider,
    input: perM(v.input_cost_per_token),
    output: perM(v.output_cost_per_token),
    cacheRead: perM(v.cache_read_input_token_cost),
    cacheWrite5m: perM(v.cache_creation_input_token_cost),
    cacheWrite1h: perM(v.cache_creation_input_token_cost_above_1hr),
  };
}

const out = {
  source: "LiteLLM model_prices_and_context_window.json (MIT)",
  retrieved: new Date().toISOString().slice(0, 10),
  unit: "USD per 1M tokens",
  models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync("src/pricing/prices.json", JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${Object.keys(models).length} models`);
