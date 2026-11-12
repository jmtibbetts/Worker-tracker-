'use strict';

/**
 * AI tool detection.
 *
 * Each signature can match on:
 *   processes - executable / application names (exact, case-insensitive, ".exe" ignored)
 *   titles    - words or phrases looked for in the active window title
 *   domains   - hostnames of the active browser tab (where the platform exposes it)
 *
 * Extra tools can be added by the user in Settings without changing this file.
 */
const BUILTIN_SIGNATURES = [
  { name: 'ChatGPT', kind: 'assistant', processes: ['chatgpt'], titles: ['ChatGPT'], domains: ['chatgpt.com', 'chat.openai.com'] },
  { name: 'OpenAI Platform', kind: 'assistant', titles: ['OpenAI Platform', 'OpenAI Playground'], domains: ['platform.openai.com'] },
  { name: 'Codex', kind: 'coding', processes: ['codex'], titles: ['OpenAI Codex'] },
  { name: 'Gemini', kind: 'assistant', processes: ['gemini'], titles: ['Google Gemini', 'Gemini'], domains: ['gemini.google.com'] },
  { name: 'Google AI Studio', kind: 'assistant', titles: ['Google AI Studio'], domains: ['aistudio.google.com'] },
  { name: 'NotebookLM', kind: 'assistant', titles: ['NotebookLM'], domains: ['notebooklm.google.com'] },
  { name: 'GitHub Copilot', kind: 'coding', titles: ['GitHub Copilot', 'Copilot Chat'], domains: ['github.com/copilot'] },
  { name: 'Microsoft Copilot', kind: 'assistant', processes: ['copilot', 'microsoft copilot', 'm365copilot'], titles: ['Microsoft Copilot', 'Copilot'], domains: ['copilot.microsoft.com', 'm365.cloud.microsoft'] },
  { name: 'Perplexity', kind: 'assistant', processes: ['perplexity'], titles: ['Perplexity'], domains: ['perplexity.ai'] },
  { name: 'DeepSeek', kind: 'assistant', titles: ['DeepSeek'], domains: ['chat.deepseek.com', 'deepseek.com'] },
  { name: 'Grok', kind: 'assistant', processes: ['grok'], titles: ['Grok'], domains: ['grok.com', 'x.ai'] },
  { name: 'Le Chat (Mistral)', kind: 'assistant', titles: ['Le Chat', 'Mistral AI'], domains: ['chat.mistral.ai'] },
  { name: 'Meta AI', kind: 'assistant', titles: ['Meta AI'], domains: ['meta.ai'] },
  { name: 'Poe', kind: 'assistant', processes: ['poe'], titles: [], domains: ['poe.com'] },
  { name: 'HuggingChat', kind: 'assistant', titles: ['HuggingChat'], domains: ['huggingface.co/chat'] },
  { name: 'Phind', kind: 'assistant', titles: ['Phind'], domains: ['phind.com'] },
  { name: 'You.com', kind: 'assistant', titles: ['You.com'], domains: ['you.com'] },
  { name: 'Cursor', kind: 'coding', processes: ['cursor'], titles: [], domains: ['cursor.com'] },
  { name: 'Windsurf', kind: 'coding', processes: ['windsurf'], titles: ['Windsurf'], domains: ['windsurf.com'] },
  { name: 'Codeium', kind: 'coding', titles: ['Codeium'], domains: ['codeium.com'] },
  { name: 'Tabnine', kind: 'coding', processes: ['tabnine'], titles: ['Tabnine'], domains: ['tabnine.com'] },
  { name: 'Aider', kind: 'coding', processes: ['aider'], titles: [] },
  { name: 'v0', kind: 'coding', titles: ['v0 by Vercel'], domains: ['v0.dev', 'v0.app'] },
  { name: 'Bolt', kind: 'coding', titles: ['bolt.new'], domains: ['bolt.new'] },
  { name: 'Lovable', kind: 'coding', titles: ['Lovable'], domains: ['lovable.dev'] },
  { name: 'Replit Agent', kind: 'coding', titles: ['Replit Agent'] },
  { name: 'Ollama', kind: 'local-model', processes: ['ollama', 'ollama app'], titles: ['Ollama'] },
  { name: 'LM Studio', kind: 'local-model', processes: ['lm studio', 'lmstudio'], titles: ['LM Studio'] },
  { name: 'GPT4All', kind: 'local-model', processes: ['gpt4all'], titles: ['GPT4All'] },
  { name: 'Jan', kind: 'local-model', processes: ['jan'], titles: [] },
  { name: 'Open WebUI', kind: 'local-model', titles: ['Open WebUI'] },
  { name: 'Midjourney', kind: 'media', titles: ['Midjourney'], domains: ['midjourney.com'] },
  { name: 'DALL-E', kind: 'media', titles: ['DALL·E', 'DALL-E'] },
  { name: 'Stable Diffusion', kind: 'media', processes: ['comfyui', 'diffusionbee', 'draw things'], titles: ['Stable Diffusion', 'ComfyUI', 'DiffusionBee'] },
  { name: 'Adobe Firefly', kind: 'media', titles: ['Adobe Firefly'], domains: ['firefly.adobe.com'] },
  { name: 'Runway', kind: 'media', titles: ['Runway ML', 'RunwayML'], domains: ['runwayml.com'] },
  { name: 'Suno', kind: 'media', titles: ['Suno'], domains: ['suno.com'] },
  { name: 'ElevenLabs', kind: 'media', titles: ['ElevenLabs'], domains: ['elevenlabs.io'] },
  { name: 'Jasper', kind: 'writing', titles: ['Jasper AI'], domains: ['jasper.ai'] },
  { name: 'Copy.ai', kind: 'writing', titles: ['Copy.ai'], domains: ['copy.ai'] },
  { name: 'Writesonic', kind: 'writing', titles: ['Writesonic'], domains: ['writesonic.com'] },
  { name: 'QuillBot', kind: 'writing', titles: ['QuillBot'], domains: ['quillbot.com'] },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleRegex(phrase) {
  // Word-boundary style match that also works for phrases with punctuation.
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(phrase.toLowerCase())}($|[^a-z0-9])`, 'i');
}

function normalizeProcess(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.(exe|app)$/, '');
}

/** Parse the user's custom tools ("Name | keyword, keyword" per line). */
function parseCustomTools(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [namePart, keywordPart] = line.split('|');
    const name = namePart.trim();
    if (!name) continue;
    const keywords = (keywordPart || name)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    out.push({
      name,
      kind: 'custom',
      processes: keywords.map((k) => k.toLowerCase()),
      titles: keywords,
      domains: keywords.filter((k) => k.includes('.')).map((k) => k.toLowerCase()),
    });
  }
  return out;
}

function buildSignatures(customText) {
  // Custom tools go first so a user-defined name wins over a built-in one.
  return [...parseCustomTools(customText), ...BUILTIN_SIGNATURES].map((s) => ({
    name: s.name,
    kind: s.kind,
    processes: (s.processes || []).map(normalizeProcess),
    titleRes: (s.titles || []).map(titleRegex),
    domains: (s.domains || []).map((d) => d.toLowerCase()),
  }));
}

function urlMatchesDomain(url, domain) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const [domainHost, ...pathParts] = domain.split('/');
  if (host !== domainHost && !host.endsWith('.' + domainHost)) return false;
  if (!pathParts.length) return true;
  return parsed.pathname.toLowerCase().startsWith('/' + pathParts.join('/'));
}

/**
 * Decide whether the foreground window is an AI tool.
 * @param {{app?: string, process?: string, title?: string, url?: string}} win
 * @returns {{name: string, kind: string, via: 'url'|'app'|'title'}|null}
 */
function detectForeground(win, signatures) {
  if (!win) return null;
  const names = [normalizeProcess(win.app), normalizeProcess(win.process)].filter(Boolean);
  const title = String(win.title || '');
  const url = String(win.url || '');
  if (url) {
    for (const s of signatures) {
      if (s.domains.some((d) => urlMatchesDomain(url, d))) return { name: s.name, kind: s.kind, via: 'url' };
    }
  }
  if (names.length) {
    for (const s of signatures) {
      if (s.processes.some((p) => names.includes(p))) return { name: s.name, kind: s.kind, via: 'app' };
    }
  }
  if (title) {
    for (const s of signatures) {
      if (s.titleRes.some((re) => re.test(title))) return { name: s.name, kind: s.kind, via: 'title' };
    }
  }
  return null;
}

/** Return the names of AI tools found in a list of running process names. */
function detectProcesses(processNames, signatures) {
  const running = new Set((processNames || []).map(normalizeProcess));
  const found = [];
  for (const s of signatures) {
    if (s.processes.some((p) => running.has(p)) && !found.includes(s.name)) found.push(s.name);
  }
  return found;
}

module.exports = { BUILTIN_SIGNATURES, buildSignatures, parseCustomTools, detectForeground, detectProcesses };
