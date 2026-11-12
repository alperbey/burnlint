import { cacheThrash } from "./cache-thrash.js";
import { duplicateToolCall } from "./duplicate-tool-call.js";
import { rereadUnchanged } from "./reread-unchanged.js";
import type { Rule } from "./types.js";

export const rules: Rule[] = [duplicateToolCall, rereadUnchanged, cacheThrash];

export { defaultConfig } from "./types.js";
export type { Rule, RuleConfig, RuleContext } from "./types.js";
