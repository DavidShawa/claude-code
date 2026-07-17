import { Settings } from '../../components/Settings/Settings.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

/**
 * /usage — unified command replacing /cost and /stats (v2.1.118 upstream alignment).
 *
 * Routing (handled inside Settings → Usage tab):
 *   - claude.ai / firstParty → Claude plan limits + overages (OAuth usage API)
 *   - OpenAI ChatGPT OAuth  → Codex plan windows (5h / weekly) via codex/usage API
 *   - OpenAI API key        → RPM/TPM from last response headers + session cost
 *
 * Both /cost and /stats are registered as aliases of this command so that
 * existing muscle-memory still works.
 */
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Usage" />;
};
