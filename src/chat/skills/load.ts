// Renders the Ask Coop Data Analyst skill into one system-prompt section (design 4d). Pure Node: no server-only, so
// vitest can import it. Reads the markdown once per process and caches the result.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {CRM_TOPICS, EXPLORE_TOPICS, SKILL_CONSTANTS, SKILL_TOPICS} from './rules';

const DEFAULT_SKILL_DIR = 'src/chat/skills/ask-coop-data-analyst';
const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

const cached = new Map<string, string>();

function parseFrontmatter(raw: string): {name: string; description: string; body: string} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('SKILL.md has no frontmatter');
  const field = (key: string): string => {
    const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
    if (!line) throw new Error(`SKILL.md frontmatter is missing "${key}"`);
    return line.slice(key.length + 1).trim();
  };
  return {name: field('name'), description: field('description'), body: m[2]};
}

function fillConstants(text: string, constants: Record<string, number>): string {
  const used = new Set<string>();
  const out = text.replace(PLACEHOLDER, (_all, key: string) => {
    if (!(key in constants)) throw new Error(`Skill placeholder {{${key}}} has no constant`);
    used.add(key);
    return String(constants[key]);
  });
  const unused = Object.keys(constants).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`Skill constants never used in the text: ${unused.join(', ')}`);
  return out;
}

/** Offline token estimate (characters / 3.5), used by the budget test. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Keeps `[[explore]]` blocks only when `explore`, `[[!explore]]` blocks only when not. Markers sit on their own lines and are
 * always removed, so dropping them leaves the other variant's text byte-for-byte as written.
 */
export function applyVariant(text: string, explore: boolean): string {
  for (const kind of ['explore', '!explore']) {
    const opens = text.match(new RegExp(`^\\[\\[${kind}\\]\\]`, 'gm'))?.length ?? 0;
    const closes = text.match(new RegExp(`^\\[\\[/${kind}\\]\\]`, 'gm'))?.length ?? 0;
    if (opens !== closes) throw new Error('Unbalanced [[explore]] marker in the skill text');
  }
  const drop = explore ? '!explore' : 'explore';
  const dropBlock = new RegExp(`^\\[\\[${drop}\\]\\][ \\t]*\\r?\\n[\\s\\S]*?^\\[\\[/${drop}\\]\\][ \\t]*(?:\\r?\\n|$)`, 'gm');
  const out = text.replace(dropBlock, '').replace(/^\[\[\/?!?explore\]\][ \t]*\r?\n?/gm, '');
  if (/\[\[\/?!?explore\]\]/.test(out)) throw new Error('Unbalanced [[explore]] marker in the skill text');
  return out;
}

/**
 * The whole skill as one string: the core, then each topic under a heading in SKILL_TOPICS order (plus EXPLORE_TOPICS when
 * `explore`, and CRM_TOPICS when `crm`). Cached per variant for the default directory; an injected `dir` or `constants` (tests) is always read fresh.
 */
export function renderSkill(opts?: {explore?: boolean; crm?: boolean; dir?: string; constants?: Record<string, number>}): string {
  const explore = opts?.explore === true;
  const crm = opts?.crm === true;
  const slot = `${explore ? 'explore' : 'base'}${crm ? '+crm' : ''}`;
  const isDefault = !opts?.dir && !opts?.constants;
  const hit = isDefault ? cached.get(slot) : undefined;
  if (hit !== undefined) return hit;
  const dir = opts?.dir ?? path.join(process.cwd(), DEFAULT_SKILL_DIR);
  const {name, description, body} = parseFrontmatter(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  // The name and description live only in the heading line of the rendered text.
  const core = applyVariant(body, explore).trim().replace(/^# (.+)$/m, (_h, title: string) => `# ${title} (${name}): ${description}`);
  const names: readonly string[] = [...SKILL_TOPICS, ...(explore ? EXPLORE_TOPICS : []), ...(crm ? CRM_TOPICS : [])];
  const topics = names.map((topic) => {
    const text = applyVariant(readFileSync(path.join(dir, 'topics', `${topic}.md`), 'utf8'), explore).trim();
    return text.replace(/^# (.+)$/m, (_h, title: string) => `## Topic: ${topic} (${title})`);
  });
  const rendered = fillConstants([core, ...topics].join('\n\n'), opts?.constants ?? SKILL_CONSTANTS);
  if (isDefault) cached.set(slot, rendered);
  return rendered;
}
