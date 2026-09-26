const JSZip = require('jszip');

// Extracted game component defaults, not material-name guesses:
// https://raw.githubusercontent.com/noita-player/noitadumps/master/noitabeta/component_documentation.txt
const DAMAGE_DEFAULTS = { blood_material: 'blood_fading', ragdoll_material: 'meat' };
const COMPONENTS = new Set(['DamageModelComponent', 'PhysicsImageShapeComponent', 'PhysicsBodyComponent', 'PhysicsBody2Component']);

/** Noita accepts duplicate XML attributes and non-XML comments in its assets.
 * Read the entity/component tree without an HTML parser repairing its shape.
 * Quoted values, comments, and nested child entities must remain separate. */
function parseEntity(xml) {
  const document = { name: '#document', attrs: {}, children: [] };
  const stack = [document];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?([\w:.-]+)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  for (const match of xml.matchAll(tokens)) {
    if (!match[1]) continue;
    if (match[0].startsWith('</')) {
      if (stack.length > 1 && stack.at(-1).name === match[1]) stack.pop();
      continue;
    }
    const attrs = {};
    const materialAttributes = {};
    for (const attr of match[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = attr[2] ?? attr[3];
      if (!(attr[1] in attrs)) attrs[attr[1]] = value;
      // Keep every distinct material value; never guess the game's duplicate
      // attribute precedence. Some boss descriptions explicitly list both.
      if (['blood_material', 'ragdoll_material', 'material'].includes(attr[1])) {
        if (!materialAttributes[attr[1]]) materialAttributes[attr[1]] = [];
        if (!materialAttributes[attr[1]].includes(value)) materialAttributes[attr[1]].push(value);
      }
    }
    const node = { name: match[1], attrs, materialAttributes, children: [] };
    stack.at(-1).children.push(node);
    if (!/\/\s*>$/.test(match[0])) stack.push(node);
  }
  return document.children.find(node => node.name === 'Entity') ?? document;
}

async function createCreatureMaterialResolver(archiveBytes, materialIds) {
  const archive = await JSZip.loadAsync(archiveBytes);
  const trees = new Map();
  const byName = new Map();
  const byBasename = new Map();
  const files = Object.keys(archive.files).filter(file => /^data\/entities\/.*\.xml$/.test(file));
  await Promise.all(files.map(async file => {
    const tree = parseEntity(await archive.file(file).async('string'));
    trees.set(file, tree);
    const name = tree.attrs.name;
    if (name?.startsWith('$animal_')) {
      const id = name.slice('$animal_'.length);
      if (!byName.has(id)) byName.set(id, []);
      byName.get(id).push(file);
    }
    const id = file.slice(file.lastIndexOf('/') + 1, -4);
    if (!byBasename.has(id)) byBasename.set(id, []);
    byBasename.get(id).push(file);
  }));
  const cache = new Map();
  function components(file, visiting = new Set()) {
    if (cache.has(file)) return cache.get(file);
    if (visiting.has(file)) throw new Error(`Cyclic creature entity inheritance: ${file}`);
    const root = trees.get(file);
    if (!root) throw new Error(`Missing creature base entity: ${file}`);
    const active = new Set(visiting).add(file);
    const models = [];
    for (const node of root.children) {
      if (COMPONENTS.has(node.name)) {
        models.push({ type: node.name, ...(node.name === 'DamageModelComponent' ? DAMAGE_DEFAULTS : {}), ...node.attrs,
          materialAttributes: node.materialAttributes });
      } else if (node.name === 'Base' && node.attrs.file) {
        let inherited = components(node.attrs.file, active).map(model => ({ ...model }));
        for (const override of node.children.filter(child => COMPONENTS.has(child.name))) {
          const matches = model => model.type === override.name
            && (!override.attrs._tags || model._tags === override.attrs._tags);
          if (override.attrs._remove_from_base === '1') inherited = inherited.filter(model => !matches(model));
          else inherited = inherited.map(model => matches(model) ? { ...model, ...override.attrs,
            materialAttributes: { ...model.materialAttributes, ...override.materialAttributes } } : model);
        }
        models.push(...inherited);
      }
      // Nested <Entity> nodes are child objects, never the creature's stats.
    }
    cache.set(file, models);
    return models;
  }
  function pathsFor(id) {
    for (const path of [`data/entities/animals/${id}.xml`, `data/entities/animals/${id}/${id}.xml`, `data/entities/${id}.xml`]) {
      if (trees.has(path)) return [path];
    }
    // The actual Entity name links skins such as basebot_sentry to "sentry".
    const named = byName.get(id);
    if (named?.length) return named;
    return byBasename.get(id) ?? [];
  }
  return ids => {
    let resolved = [];
    for (const id of ids) {
      resolved = pathsFor(id).map(file => components(file)).filter(list => list.some(model => model.type === 'DamageModelComponent'));
      if (resolved.length) break;
    }
    const unique = valuesList => {
      const values = new Set(valuesList);
      if (values.size !== 1) return null;
      const value = [...values][0];
      return materialIds.has(value) ? value : null;
    };
    const values = (model, key) => model.materialAttributes[key] ?? [model[key]];
    const blood = resolved.flatMap(list => list.filter(model => model.type === 'DamageModelComponent').flatMap(model => values(model, 'blood_material')));
    const corpse = resolved.flatMap(list => {
      const retainedBody = list.some(model => /^PhysicsBody2?Component$/.test(model.type) && model.on_death_leave_physics_body === '1');
      const shapes = list.filter(model => model.type === 'PhysicsImageShapeComponent');
      if (retainedBody && shapes.length) return shapes.flatMap(model => values(model, 'material'));
      return list.filter(model => model.type === 'DamageModelComponent').flatMap(model => model.create_ragdoll === '0' ? [null] : values(model, 'ragdoll_material'));
    });
    return { bloodMaterialId: unique(blood), corpseMaterialId: unique(corpse),
      bloodMaterialCandidates: [...new Set(blood)].filter(value => materialIds.has(value)),
      corpseMaterialCandidates: [...new Set(corpse)].filter(value => materialIds.has(value)) };
  };
}

module.exports = { createCreatureMaterialResolver };
