#!/usr/bin/env node
/** Local files only. This utility never contacts DeepL or a translation API. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = 'noitaguessr-manual-translation-v1';
const LANGUAGES = { ja: { name: 'Japanese', csv: 'jp' }, zh: { name: 'Chinese (Simplified)', csv: 'zh-cn' } };
const DEFAULT_BATCH_CHARACTERS = 2500;
const sortedObject = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.entries(sortedObject(value)).map(([key, item]) => [key, JSON.parse(canonical(item))]))
  : value);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
export const stableTranslationId = key => `G${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
export const placeholderMultiset = text => [...text.matchAll(/\{\{[^{}]*\}\}/g)].map(match => match[0]).sort();

function requireCatalog(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a flat JSON object.`);
  for (const [key, text] of Object.entries(value)) {
    if (!key || typeof text !== 'string' || !text.trim()) throw new Error(`${label} has an empty or non-string entry: ${key}`);
  }
  return value;
}

function validatePlaceholders(source, text, id) {
  if (canonical(placeholderMultiset(source)) !== canonical(placeholderMultiset(text))
    || text.replace(/\{\{[^{}]*\}\}/g, '').match(/\{\{|\}\}/)) {
    throw new Error(`Placeholder multiset mismatch for ${id}; preserve every {{placeholder}} exactly, including repeated occurrences.`);
  }
}

function entryContext(key) {
  const specific = {
    Close: 'Action: dismiss a dialog. This does not mean geographically near.',
    Daily: 'Noun: the daily map-guessing challenge.',
    'Where are you?': 'Title above the clue map before the answer is revealed.',
    'Revealed area': 'Title above the clue map after the answer is revealed.',
    Connected: 'Twitch chat connection status; this does not mean that a stream is live.',
    Area: 'Scoring component for identifying the correct Noita biome or named area.',
    Proximity: 'Scoring component for how near the guess is to the actual location.',
    Free: 'A clue exploration action with no point cost.',
  };
  const plural = key.match(/_(zero|one|two|few|many|other)$/)?.[1];
  const base = plural ? key.slice(0, -plural.length - 1) : key;
  const context = specific[base] ?? (
    /gift|Patreon|membership|sign.in|sign.out|Pro\b|account|subscri/i.test(base) ? 'Account, membership or recipient-specific gift interface.' :
    /chat|Twitch|stream|channel|host|player/i.test(base) ? 'Multiplayer interface: the streamer hosts and viewers send guesses through Twitch chat.' :
    /clue|zoom|travel|position|cost|view|point/i.test(base) ? 'Map-guessing gameplay, clue exploration or scoring interface.' :
    /daily/i.test(base) ? 'Daily map-guessing challenge interface.' : 'Map-guessing game interface, navigation or status message.');
  return context + (plural ? ` English plural category: ${plural}. Japanese and Chinese can use the same wording for one and other.` : '');
}

/** The reuse table is already vetted by source context; do not reverse-match English map labels. */
export function createTranslationPlan({ source, language, existing = {}, reused = {}, seed = false, maxBatchCharacters = DEFAULT_BATCH_CHARACTERS }) {
  requireCatalog(source, 'English source');
  requireCatalog(existing, 'Existing target catalog');
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error(`Unsupported manual language: ${language}`);
  if (!Number.isInteger(maxBatchCharacters) || maxBatchCharacters < 500) throw new Error('Batch size must be an integer of at least 500 characters.');
  const entries = [];
  const ids = new Set();
  for (const [key, text] of Object.entries(sortedObject(source))) {
    if (text.includes('[[') || text.includes(']]')) throw new Error(`Source uses reserved batch delimiters: ${key}`);
    const id = stableTranslationId(key);
    if (ids.has(id)) throw new Error(`Duplicate stable ID: ${id}`);
    ids.add(id);
    const entry = { id, key, source: text, placeholders: placeholderMultiset(text), context: entryContext(key) };
    if (Object.hasOwn(reused, key)) {
      const { value, mapKey } = reused[key];
      if (typeof value !== 'string' || !value.trim() || typeof mapKey !== 'string' || !mapKey) throw new Error(`Invalid reused translation: ${key}`);
      validatePlaceholders(text, value, id);
      entries.push({ ...entry, status: 'reused', value, mapKey });
    } else if (Object.hasOwn(existing, key) && existing[key].trim() !== text.trim()) {
      validatePlaceholders(text, existing[key], id);
      entries.push({ ...entry, status: 'existing', value: existing[key] });
    } else {
      entries.push({ ...entry, status: 'pending' });
    }
  }
  const seededCatalog = Object.fromEntries(entries.filter(entry => entry.status !== 'pending').map(entry => [entry.key, entry.value]));
  const batches = [];
  // Leave room for the fingerprint header/footer; the limit is a local convenience,
  // not a claim about the current limits of any DeepL account.
  let batch;
  let count = 0;
  for (const entry of entries.filter(entry => entry.status === 'pending')) {
    const characters = [...renderEntry(entry, entry.source)].length + 2;
    if (characters + 230 > maxBatchCharacters) throw new Error(`Entry ${entry.id} exceeds the batch size; increase --batch-characters.`);
    if (!batch || count + characters > maxBatchCharacters) {
      batch = { file: `batch-${String(batches.length + 1).padStart(3, '0')}.txt`, ids: [] };
      batches.push(batch);
      count = 230;
    }
    batch.ids.push(entry.id);
    count += characters;
  }
  const body = {
    schema: SCHEMA, language, sourceFingerprint: fingerprint(source),
    catalogFingerprint: fingerprint(seed ? seededCatalog : existing), maxBatchCharacters, entries, batches,
  };
  return { ...body, fingerprint: fingerprint(body) };
}

function renderEntry(entry, text) { return `[[${entry.id}]]\n${text}\n[[/${entry.id}]]`; }
function batchToken(plan, batch) { return `GUESSR_V1_${plan.language}_${plan.fingerprint}_${batch.file.replace('.txt', '')}`; }
export function renderSourceBatch(plan, batch) {
  const entries = new Map(plan.entries.map(entry => [entry.id, entry]));
  const token = batchToken(plan, batch);
  return `[[${token}]]\n\n${batch.ids.map(id => renderEntry(entries.get(id), entries.get(id).source)).join('\n\n')}\n\n[[/${token}]]\n`;
}

export function validateTranslationPlan(plan, { source, existing, reused }) {
  if (plan?.schema !== SCHEMA) throw new Error('Unsupported manifest schema; regenerate the manual translation pack.');
  if (plan.sourceFingerprint !== fingerprint(source)) throw new Error('Stale English source fingerprint; regenerate the manual translation pack.');
  if (plan.catalogFingerprint !== fingerprint(existing)) throw new Error('Target catalog changed since export; regenerate before importing.');
  const { fingerprint: recorded, ...body } = plan;
  if (recorded !== fingerprint(body)) throw new Error('Manifest fingerprint mismatch; the manifest was modified or is incomplete.');
  const expected = createTranslationPlan({ source, language: plan.language, existing, reused, maxBatchCharacters: plan.maxBatchCharacters });
  if (canonical(expected) !== canonical(plan)) throw new Error('Manifest differs from the current source, reuse values, IDs or batch inventory; regenerate it.');
}

function parseResponse(plan, batch, raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const token = batchToken(plan, batch);
  const lines = text.split('\n');
  if (lines.shift() !== `[[${token}]]` || lines.pop() !== `[[/${token}]]`) {
    throw new Error(`Stale or malformed batch fingerprint/header/footer in ${batch.file}. Preserve the original markers.`);
  }
  const values = new Map();
  let open;
  let content = [];
  for (const line of lines) {
    const start = line.match(/^\[\[(G[0-9a-f]{16})\]\]$/);
    const end = line.match(/^\[\[\/(G[0-9a-f]{16})\]\]$/);
    if (start) {
      if (open) throw new Error(`Incomplete ID ${open} in ${batch.file}; closing marker missing.`);
      if (values.has(start[1])) throw new Error(`Repeated ID ${start[1]} in ${batch.file}.`);
      if (!batch.ids.includes(start[1])) throw new Error(`Unknown ID ${start[1]} in ${batch.file}.`);
      open = start[1];
      content = [];
    } else if (end) {
      if (!open || open !== end[1]) throw new Error(`Mismatched closing ID ${end[1]} in ${batch.file}.`);
      const value = content.join('\n').trim();
      if (!value || /^(?:\[?PASTE[_ ]TRANSLATION(?:[_ ]HERE)?\]?|TODO|TBD)$/i.test(value)) throw new Error(`Incomplete translation for ${open}.`);
      values.set(open, value);
      open = undefined;
    } else if (line.includes('[[') || line.includes(']]')) {
      throw new Error(`Malformed ID marker in ${batch.file}: ${line}`);
    } else if (open) {
      content.push(line);
    } else if (line.trim()) {
      throw new Error(`Unexpected text outside an ID in ${batch.file}.`);
    }
  }
  if (open) throw new Error(`Incomplete ID ${open} in ${batch.file}; closing marker missing.`);
  const missing = batch.ids.filter(id => !values.has(id));
  if (missing.length) throw new Error(`Missing IDs in ${batch.file}: ${missing.join(', ')}`);
  return values;
}

function splitCombinedResponse(plan, raw) {
  const batches = new Map(plan.batches.map(batch => [`[[${batchToken(plan, batch)}]]`, batch]));
  const responses = {};
  let active;
  let lines = [];
  for (const line of raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const start = batches.get(line);
    if (start) {
      if (active) throw new Error(`Incomplete combined batch ${active.file}; closing fingerprint marker missing.`);
      if (Object.hasOwn(responses, start.file)) throw new Error(`Repeated batch in all.txt: ${start.file}`);
      active = start;
      lines = [line];
    } else if (active) {
      lines.push(line);
      if (line === `[[/${batchToken(plan, active)}]]`) {
        responses[active.file] = lines.join('\n');
        active = undefined;
      }
    } else if (line.trim()) {
      throw new Error('Stale, unknown or malformed batch fingerprint, or unexpected text in all.txt.');
    }
  }
  if (active) throw new Error(`Incomplete combined batch ${active.file}; closing fingerprint marker missing.`);
  return responses;
}

/** No writes happen here: every batch and every entry must pass together.
 * @returns {Record<string, string>} */
export function validateResponses(plan, responses, unchangedReviewed = []) {
  if (!Array.isArray(unchangedReviewed) || unchangedReviewed.some(id => typeof id !== 'string')
    || new Set(unchangedReviewed).size !== unchangedReviewed.length) throw new Error('unchanged-reviewed.json must contain unique ID strings.');
  if (Object.hasOwn(responses, 'all.txt')) {
    if (Object.keys(responses).length !== 1) throw new Error('Use responses/all.txt OR the numbered response files, not both.');
    responses = splitCombinedResponse(plan, responses['all.txt']);
  }
  const expectedFiles = plan.batches.map(batch => batch.file).sort();
  if (canonical(Object.keys(responses).sort()) !== canonical(expectedFiles)) throw new Error(`Missing or unexpected response files. Required: ${expectedFiles.join(', ')}`);
  const values = new Map();
  for (const batch of plan.batches) {
    for (const [id, value] of parseResponse(plan, batch, responses[batch.file])) {
      if (values.has(id)) throw new Error(`Repeated ID across batches: ${id}`);
      values.set(id, value);
    }
  }
  for (const id of unchangedReviewed) {
    const entry = plan.entries.find(entry => entry.id === id && entry.status === 'pending');
    if (!entry || values.get(id) !== entry.source.trim()) throw new Error(`Unknown or no longer unchanged reviewed ID: ${id}`);
  }
  const catalog = {};
  for (const entry of plan.entries) {
    if (entry.status !== 'pending') { Object.defineProperty(catalog, entry.key, { value: entry.value, enumerable: true }); continue; }
    const value = values.get(entry.id);
    if (!value) throw new Error(`Missing translation for ${entry.id}.`);
    validatePlaceholders(entry.source, value, entry.id);
    if (value === entry.source.trim() && !unchangedReviewed.includes(entry.id)) {
      throw new Error(`Unchanged English for ${entry.id}. Translate it, or explicitly list its ID in unchanged-reviewed.json after review.`);
    }
    // Clipboard translation can trim surrounding layout spaces; keep the source's
    // intentional spacing (for example the leading space in " · Streamer").
    const rendered = entry.source.match(/^\s*/)[0] + value + entry.source.match(/\s*$/)[0];
    Object.defineProperty(catalog, entry.key, { value: rendered, enumerable: true });
  }
  return catalog;
}

async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return {}; throw error; }
}
async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
const json = value => JSON.stringify(value, null, 2) + '\n';

/** @param {{ manifestPath: string, responseDirectory: string, sourcePath: string, catalogPath: string, reused?: Record<string, { value: string, mapKey: string }>, unchangedReviewPath?: string }} options */
export async function importTranslationFiles({ manifestPath, responseDirectory, sourcePath, catalogPath, reused = {}, unchangedReviewPath }) {
  const plan = await readJson(manifestPath);
  const source = requireCatalog(await readJson(sourcePath), 'English source');
  const existing = requireCatalog(await readJson(catalogPath, true), 'Existing target catalog');
  validateTranslationPlan(plan, { source, existing, reused });
  const files = await readdir(responseDirectory, { withFileTypes: true });
  const responses = {};
  for (const file of files.filter(file => file.name.endsWith('.txt'))) {
    if (!file.isFile()) throw new Error(`Response is not a regular file: ${file.name}`);
    responses[file.name] = await readFile(join(responseDirectory, file.name), 'utf8');
  }
  const unchangedReviewed = unchangedReviewPath ? await readJson(unchangedReviewPath) : [];
  const catalog = validateResponses(plan, responses, unchangedReviewed);
  // Recheck after reading every response to catch source/catalog edits made
  // during validation before replacing the target.
  if (fingerprint(await readJson(sourcePath)) !== plan.sourceFingerprint
    || fingerprint(await readJson(catalogPath, true)) !== plan.catalogFingerprint) throw new Error('Source or target catalog changed during import. No catalog was written.');
  await atomicWrite(catalogPath, json(catalog));
  return { language: plan.language, entries: Object.keys(catalog).length, imported: plan.entries.filter(entry => entry.status === 'pending').length, catalogFingerprint: fingerprint(catalog) };
}

async function readProject(language, root = ROOT) {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error(`Unsupported manual language: ${language}`);
  const sourcePath = join(root, 'src/guessr/locales/en.json');
  const catalogPath = join(root, `src/guessr/locales/${language}.json`);
  const source = await readJson(sourcePath);
  const existing = await readJson(catalogPath, true);
  const map = await readJson(join(root, `src/locales/${language}/translation.json`));
  const { GUESSR_REUSED_TRANSLATIONS, resolveReusedGuessrTranslation } = await import(pathToFileURL(join(root, 'src/guessr/reused-translations.ts')).href);
  const reused = {};
  for (const key of Object.keys(source)) {
    const value = resolveReusedGuessrTranslation(key, map, language);
    if (value !== undefined) reused[key] = { value, mapKey: GUESSR_REUSED_TRANSLATIONS[key] };
  }
  return { source, existing, reused, sourcePath, catalogPath };
}

/** RFC-style quoted fields, escaped quotes, commas and real embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Unterminated quoted field in the official terminology CSV.');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function officialGlossary(csv, language) {
  const [header, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
  const english = header.indexOf('en'), target = header.indexOf(LANGUAGES[language].csv);
  if (english < 0 || target < 0) throw new Error('Official terminology CSV is missing a required language column.');
  // Biome labels are injected dynamically; these are reference terms, not new UI translations.
  return rows.filter(row => /^(?:biome_|item_)/.test(row[0]) && row[english]?.trim() && row[target]?.trim()
    && !/_desc(?:ription)?(?:_|$)/.test(row[0]) && row[english].length <= 80 && row[target].length <= 100)
    .map(row => ({ key: row[0], english: row[english], translation: row[target] }));
}

function contextText(plan) {
  return `ENGLISH CONTEXT — ${LANGUAGES[plan.language].name}\n\nNoitaGuessr is a map-guessing game using Noita locations. The left panel shows a clue; the right panel accepts a map pin. The player identifies the clue's starting location. Exploring the clue can spend score points; returning and zooming in are free. Area and proximity are separate score components.\n\nDaily means the daily challenge. Demo is free practice. In Chat vs Streamer, a streamer hosts, viewers place guesses, and the streamer's submission closes the round. Connected describes the chat connection. Pro membership belongs to the streamer; local tests do not verify paid membership.\n\nPreserve Noita, NoitaGuessr, Noitamap, Twitch, Patreon and Chatterino as product names. Preserve JSON, HTML, URLs, !guess commands, coordinates and all {{placeholders}} exactly. Translate surrounding prose. Never translate user names, channel names or actual chat messages; these arrive through placeholders.\n\nUse a concise, natural game-interface tone. A point is a score unit, a pin is a map marker, a round is one location to guess, and a clue is the partial map view. Close dismisses a dialog; it does not mean near. Daily names a challenge; it is not merely the adjective daily. Japanese and Simplified Chinese are the target locales.\n\nThe official-game-glossary.tsv is copied verbatim from src/game-translations/common.csv (${LANGUAGES[plan.language].csv} column). Use those names for Noita biomes/items and ask the user about uncertain game terminology. Do not invent names. Existing reviewed map translations are in reused-map-translations.tsv and are already excluded from the batches.\n\nEntry IDs and batch fingerprints are technical markers. Do not translate, delete, renumber or add markers. The English plural keys are documented below; the translated text never includes the key's _one or _other suffix.\n\nENTRY CONTEXT\n\n` + plan.entries.filter(entry => entry.status === 'pending').map(entry => `${entry.id}\nKey: ${entry.key}\nEnglish: ${entry.source}\nContext: ${entry.context}\nPlaceholders: ${entry.placeholders.join(', ') || '(none)'}\n`).join('\n');
}

function instructionsText(outputRoot, plans) {
  const relativeOutput = outputRoot.startsWith(ROOT + '/') ? outputRoot.slice(ROOT.length + 1) : outputRoot;
  const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  return `MANUAL DEEPL FILES — no translation service has been called\n\n1. Choose ja (Japanese) or zh (Simplified Chinese). Read its context.txt; official-game-glossary.tsv contains Noita terminology copied from common.csv. reused-map-translations.tsv lists reviewed text already excluded from translation. Pending strings currently use English fallback in the game.\n2. In the DeepL website, select English as source and the target language. If your available text limit allows it, paste that language's complete all-source.txt. Otherwise paste one complete source/batch-NNN.txt at a time. Keep all markers. The small batches use a ${plans[0].maxBatchCharacters}-character cap for convenience; check your available website limit.\n3. Review the result for gameplay meaning and official terminology. Save the full output as UTF-8:\n   One combined translation: <language>/responses/all.txt\n   Separate batches: <language>/responses/batch-001.txt, batch-002.txt, etc.\n   Use one method for a language. Keep every [[marker]], {{placeholder}} and fingerprint unchanged. Restore markers from the source if the website changes them. Do not put context or glossary text in responses.\n4. Check short labels and plural variants. If a string should intentionally stay identical to English (for example coordinate notation or a placeholder-only layout), add its G... ID to that language's unchanged-reviewed.json after reviewing it. Example format: ["G0123456789abcdef"]. Otherwise unchanged English is rejected to prevent importing source files accidentally.\n5. Once the whole language is complete, import it from the repository root:\n\n${plans.map(plan => `node build_scripts/guessr/manual-deepl.mjs import --manifest ${shellQuote(`${relativeOutput}/${plan.language}/manifest.json`)}`).join('\n')}\n\nThe importer verifies the schema, current English source, target catalog, current reused map values, fingerprints, every ID, and the exact placeholder multiset. It rejects empty, missing, duplicate, unknown, stale or malformed entries. After every check succeeds, it atomically replaces only src/guessr/locales/<language>.json. Shared map translation files are never written. A successful import is not a linguistic quality review.\n\nTo regenerate after an English inventory change:\n\nnode build_scripts/guessr/manual-deepl.mjs export --seed --output ${shellQuote(relativeOutput)}\n\nRegeneration refuses to overwrite a language pack with response text or reviewed unchanged IDs; choose a fresh --output directory to preserve work in progress. Stable G... IDs stay the same for unchanged keys; fingerprints prevent importing old batches against changed source text. No API key, account change, browser automation, commit, server restart or deployment is involved.\n`;
}

export async function exportManualPacks({ root = ROOT, outputRoot = join(ROOT, 'task/guessr/deepl'), languages = ['ja', 'zh'], seed = false, maxBatchCharacters = DEFAULT_BATCH_CHARACTERS } = {}) {
  const projects = [];
  for (const language of languages) {
    const project = await readProject(language, root);
    const plan = createTranslationPlan({ ...project, language, seed, maxBatchCharacters });
    const directory = join(outputRoot, language);
    try {
      const responses = await readdir(join(directory, 'responses'));
      if (responses.some(name => name.endsWith('.txt'))) throw new Error(`Responses already exist in ${directory}; use a fresh --output directory to preserve them.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const reviewed = await readJson(join(directory, 'unchanged-reviewed.json'), true);
    if (Object.keys(reviewed).length) throw new Error(`Reviewed unchanged IDs already exist in ${directory}; use a fresh --output directory to preserve them.`);
    projects.push({ ...project, plan, directory });
  }
  const csv = await readFile(join(root, 'src/game-translations/common.csv'), 'utf8');
  for (const { plan, directory, catalogPath } of projects) {
    const glossary = officialGlossary(csv, plan.language);
    const kept = plan.entries.filter(entry => entry.status !== 'pending');
    const status = { schema: SCHEMA, language: plan.language, sourceFingerprint: plan.sourceFingerprint, manifestFingerprint: plan.fingerprint, status: 'manual-translation-pending', reused: plan.entries.filter(entry => entry.status === 'reused').length, existing: plan.entries.filter(entry => entry.status === 'existing').length, pending: plan.entries.filter(entry => entry.status === 'pending').map(({ id, key }) => ({ id, key })) };
    await mkdir(join(directory, 'responses'), { recursive: true });
    // Source files can be regenerated safely while responses are still empty.
    await rm(join(directory, 'source'), { recursive: true, force: true });
    await mkdir(join(directory, 'source'), { recursive: true });
    for (const batch of plan.batches) await atomicWrite(join(directory, 'source', batch.file), renderSourceBatch(plan, batch));
    await atomicWrite(join(directory, 'all-source.txt'), plan.batches.map(batch => renderSourceBatch(plan, batch).trimEnd()).join('\n\n') + '\n');
    await atomicWrite(join(directory, 'manifest.json'), json(plan));
    await atomicWrite(join(directory, 'status.json'), json(status));
    await atomicWrite(join(directory, 'unchanged-reviewed.json'), '[]\n');
    await atomicWrite(join(directory, 'context.txt'), contextText(plan));
    const tabCell = text => text.replaceAll('\t', ' ').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
    await atomicWrite(join(directory, 'official-game-glossary.tsv'), 'CSV key\tEnglish\tOfficial translation\n' + glossary.map(term => [term.key, term.english, term.translation].map(tabCell).join('\t')).join('\n') + '\n');
    await atomicWrite(join(directory, 'reused-map-translations.tsv'), 'ID\tEnglish key\tMap key\tExisting reviewed translation\n' + kept.filter(entry => entry.status === 'reused').map(entry => [entry.id, entry.key, entry.mapKey, entry.value].map(tabCell).join('\t')).join('\n') + '\n');
    if (seed) await atomicWrite(catalogPath, json(Object.fromEntries(kept.map(entry => [entry.key, entry.value]))));
  }
  await atomicWrite(join(outputRoot, 'INSTRUCTIONS.txt'), instructionsText(outputRoot, projects.map(project => project.plan)));
  return projects.map(({ plan }) => ({ language: plan.language, total: plan.entries.length, pending: plan.entries.filter(entry => entry.status === 'pending').length, reused: plan.entries.filter(entry => entry.status === 'reused').length, batches: plan.batches.length, fingerprint: plan.fingerprint }));
}

async function main(args) {
  const command = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--output', '--languages', '--batch-characters', '--manifest', '--seed'].includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or repeated option: ${key}`);
    options[key] = key === '--seed' ? true : args.shift();
    if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error(`Missing value for ${key}`);
  }
  if (command === 'export') {
    if (options['--manifest']) throw new Error('--manifest is only valid for import.');
    const languages = options['--languages']?.split(',') ?? ['ja', 'zh'];
    if (!languages.length || new Set(languages).size !== languages.length) throw new Error('Languages must be a unique comma-separated list.');
    const result = await exportManualPacks({ outputRoot: resolve(options['--output'] ?? join(ROOT, 'task/guessr/deepl')), languages, seed: options['--seed'] === true, maxBatchCharacters: Number(options['--batch-characters'] ?? DEFAULT_BATCH_CHARACTERS) });
    console.log(json(result));
  } else if (command === 'import') {
    if (!options['--manifest'] || Object.keys(options).length !== 1) throw new Error('Import requires only --manifest PATH.');
    const manifestPath = resolve(options['--manifest']);
    const plan = await readJson(manifestPath);
    const project = await readProject(plan.language);
    const result = await importTranslationFiles({ manifestPath, responseDirectory: join(dirname(manifestPath), 'responses'), sourcePath: project.sourcePath, catalogPath: project.catalogPath, reused: project.reused, unchangedReviewPath: join(dirname(manifestPath), 'unchanged-reviewed.json') });
    await atomicWrite(join(dirname(manifestPath), 'status.json'), json({ schema: SCHEMA, status: 'manual-translation-imported', sourceFingerprint: plan.sourceFingerprint, manifestFingerprint: plan.fingerprint, ...result, pending: [] }));
    console.log(json(result));
  } else {
    throw new Error('Usage: node build_scripts/guessr/manual-deepl.mjs export --seed [--output DIR] [--languages ja,zh] [--batch-characters 2500]\n       node build_scripts/guessr/manual-deepl.mjs import --manifest task/guessr/deepl/ja/manifest.json');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
