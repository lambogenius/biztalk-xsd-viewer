import { SaxesParser, SaxesTagNS } from 'saxes';

export const XSD = 'http://www.w3.org/2001/XMLSchema';
export interface SchemaSource { uri: string; text: string; name: string }
export interface XmlNode {
  name: string; local: string; uri: string; attributes: Record<string, string>;
  namespaces: Record<string, string>; children: XmlNode[]; text: string;
  offset: number; endOffset: number; line: number; column: number; source: SchemaSource;
}
export interface Property { category: string; name: string; value: string }
export type NodeKind = 'schema' | 'record' | 'element' | 'attribute' | 'sequence' | 'choice' | 'all' | 'group' | 'type' | 'any';
export interface SchemaNode {
  id: string; name: string; kind: NodeKind; type: string; min: string; max: string;
  path: string; xpath: string; documentation: string; properties: Property[];
  children: SchemaNode[]; sourceUri: string; line: number; column: number;
  offset: number; endOffset: number; recursive?: boolean; warning?: string;
}
export interface SchemaModel {
  name: string; uri: string; namespace: string; roots: SchemaNode[];
  warnings: string[]; dependencies: { name: string; uri: string; namespace: string }[];
  stats: { records: number; fields: number; attributes: number; nodes: number };
}
export type DependencyReader = (parent: SchemaSource, location: string) => Promise<SchemaSource | undefined>;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 12000;

export function parseXml(source: SchemaSource): XmlNode {
  if (Buffer.byteLength(source.text, 'utf8') > MAX_BYTES) throw new Error('Schema exceeds the 4 MB per-file limit.');
  const parser = new SaxesParser({ xmlns: true, position: true });
  const lineStarts = [0];
  for (let i = 0; i < source.text.length; i++) if (source.text[i] === '\n') lineStarts.push(i + 1);
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  parser.on('doctype', () => { throw new Error('DOCTYPE declarations are not supported. External entities are never loaded.'); });
  parser.on('opentag', (tag: SaxesTagNS) => {
    if (++count > 100000) throw new Error('Schema exceeds the 100,000 XML node limit.');
    const offset = source.text.lastIndexOf('<', parser.position - 1);
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid; }
    const node: XmlNode = {
      name: tag.name, local: tag.local, uri: tag.uri,
      attributes: Object.fromEntries(Object.values(tag.attributes).map(a => [a.name, a.value])),
      namespaces: { ...(stack.at(-1)?.namespaces ?? {}), ...tag.ns },
      children: [], text: '', offset, endOffset: parser.position,
      line: low, column: offset - lineStarts[low], source
    };
    if (stack.length >= 256) throw new Error('XML nesting exceeds the 256-level limit.');
    if (stack.length) stack.at(-1)!.children.push(node); else root = node;
    stack.push(node);
  });
  parser.on('text', value => { if (stack.length) stack.at(-1)!.text += value; });
  parser.on('cdata', value => { if (stack.length) stack.at(-1)!.text += value; });
  parser.on('closetag', () => { const node = stack.pop(); if (node) node.endOffset = parser.position; });
  parser.write(source.text).close();
  if (!root || root.local !== 'schema' || root.uri !== XSD) throw new Error('Expected an XML Schema <schema> in the http://www.w3.org/2001/XMLSchema namespace.');
  return root;
}

const is = (n: XmlNode, local: string) => n.uri === XSD && n.local === local;
const xchildren = (n: XmlNode) => n.children.filter(c => c.uri === XSD);
const textContent = (n: XmlNode): string => [n.text, ...n.children.map(textContent)].filter(Boolean).join(' ').trim();
const documentation = (n: XmlNode): string => xchildren(n).filter(c => c.local === 'annotation').flatMap(c => c.children.filter(d => is(d, 'documentation')).map(textContent)).join('\n');
const key = (n: XmlNode) => `${n.source.uri}#${n.offset}`;
const titleCase = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** Resolves only sources supplied by the caller; there are no network or entity requests. */
export async function buildSchema(source: SchemaSource, readDependency?: DependencyReader): Promise<SchemaModel> {
  const main = parseXml(source);
  const warnings: string[] = [];
  const documents: { root: XmlNode; namespace: string }[] = [];
  const visited = new Set<string>();
  const documentFor = new Map<XmlNode, { root: XmlNode; namespace: string }>();
  let totalBytes = 0;
  async function visit(root: XmlNode, namespace: string): Promise<void> {
    const visitKey = `${root.source.uri}|${namespace}`;
    if (visited.has(visitKey)) return;
    if (documents.length >= 32) { warnings.push('Stopped resolving dependencies after 32 schemas.'); return; }
    totalBytes += Buffer.byteLength(root.source.text, 'utf8');
    if (totalBytes > 16 * 1024 * 1024) { warnings.push('Stopped resolving dependencies at the 16 MB total limit.'); return; }
    visited.add(visitKey);
    const doc = { root, namespace };
    documents.push(doc);
    const assignContext = (n: XmlNode) => { documentFor.set(n, doc); n.children.forEach(assignContext); };
    assignContext(root);
    for (const dep of xchildren(root).filter(n => ['include', 'import', 'redefine', 'override'].includes(n.local))) {
      if (['redefine', 'override'].includes(dep.local)) {
        warnings.push(`${dep.local} is displayed as source only; overridden definitions are not expanded.`); continue;
      }
      const location = dep.attributes.schemaLocation;
      if (!location) { warnings.push(`Import ${dep.attributes.namespace || '(no namespace)'} has no schemaLocation.`); continue; }
      try {
        const loaded = await readDependency?.(root.source, location);
        if (!loaded) { warnings.push(`Could not resolve ${location}. Only relative local schemas are loaded.`); continue; }
        const dependency = parseXml(loaded);
        const target = dependency.attributes.targetNamespace || '';
        if (dep.local === 'include' && target && target !== namespace) throw new Error('Included schema has a different target namespace.');
        if (dep.local === 'import' && target !== (dep.attributes.namespace || '')) throw new Error('Imported schema does not match the declared namespace.');
        await visit(dependency, dep.local === 'include' ? namespace : target);
      } catch (error) { warnings.push(`${location}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  await visit(main, main.attributes.targetNamespace || '');
  const registry = new Map<string, XmlNode>();
  for (const { root, namespace } of documents) {
    for (const node of xchildren(root)) {
      if (!node.attributes.name) continue;
      const index = `${node.local}|${namespace}|${node.attributes.name}`;
      if (registry.has(index)) warnings.push(`Duplicate ${node.local} declaration: ${node.attributes.name}.`);
      else registry.set(index, node);
    }
  }
  function resolve(n: XmlNode, qname: string, kinds: string[]): XmlNode | undefined {
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    let namespace = n.namespaces[prefix] || '';
    // Chameleon includes adopt their including schema's namespace for component references.
    const doc = documentFor.get(n)!;
    if (!namespace && !doc.root.attributes.targetNamespace && doc.namespace) namespace = doc.namespace;
    for (const kind of kinds) {
      const found = registry.get(`${kind}|${namespace}|${local}`);
      if (found) return found;
    }
    return undefined;
  }
  function builtin(n: XmlNode, qname: string): boolean {
    const colon = qname.indexOf(':');
    return (n.namespaces[colon < 0 ? '' : qname.slice(0, colon)] || '') === XSD;
  }
  let serial = 0;
  let limitReported = false;
  const stats = { records: 0, fields: 0, attributes: 0, nodes: 0 };
  function expand(n: XmlNode, parentPath: string, parentXpath: string, ancestors: Set<string>, depth: number): SchemaNode | undefined {
    if (serial >= MAX_NODES) {
      if (!limitReported) { warnings.push(`Tree truncated at ${MAX_NODES.toLocaleString('en-US')} nodes.`); limitReported = true; }
      return undefined;
    }
    const a = n.attributes;
    const doc = documentFor.get(n)!;
    const props: Property[] = [];
    const add = (category: string, name: string, value: string | undefined) => { if (value !== undefined && value !== '') props.push({ category, name, value }); };
    const name = a.name || a.ref || (n.local === 'schema' ? n.source.name : n.local);
    const kind: NodeKind = n.local === 'element' ? 'element' : n.local === 'attribute' ? 'attribute' : ['complexType', 'simpleType', 'attributeGroup'].includes(n.local) ? 'type' : n.local === 'anyAttribute' ? 'any' : n.local as NodeKind;
    const isInstance = ['element', 'attribute', 'any', 'anyAttribute'].includes(n.local);
    const localName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const isGlobal = doc.root.children.includes(n);
    const qualified = isGlobal || (a.form || doc.root.attributes[n.local === 'attribute' ? 'attributeFormDefault' : 'elementFormDefault']) === 'qualified';
    const ns = qualified ? doc.namespace : '';
    const path = isInstance ? `${parentPath}/${n.local === 'attribute' ? '@' : ''}${localName}` : parentPath;
    let xpath = parentXpath;
    if (isInstance) {
      if (n.local === 'any' || n.local === 'anyAttribute') xpath += n.local === 'anyAttribute' ? '/@*' : '/*';
      else {
        const referenced = a.ref ? resolve(n, a.ref, [n.local]) : undefined;
        const namespace = referenced ? documentFor.get(referenced)!.namespace : ns;
        xpath += `/${n.local === 'attribute' ? '@' : ''}*[local-name()=${xpathLiteral(localName)} and namespace-uri()=${xpathLiteral(namespace)}]`;
      }
    }
    const node: SchemaNode = {
      id: `n${serial++}`, name, kind, type: a.type || (a.ref ? `ref ${a.ref}` : ''),
      min: n.local === 'attribute' ? (a.use === 'required' ? '1' : '0') : a.minOccurs || '1',
      max: n.local === 'attribute' ? (a.use === 'prohibited' ? '0' : '1') : a.maxOccurs || '1',
      path: path || '/', xpath: xpath || '/', documentation: documentation(n), properties: props,
      children: [], sourceUri: n.source.uri, line: n.line, column: n.column, offset: n.offset, endOffset: n.endOffset
    };
    add('General', 'Node name', name);
    add('General', 'Node kind', titleCase(n.local));
    add('General', 'Namespace', ns || (n.local === 'schema' ? doc.namespace : undefined));
    for (const [prop, value] of Object.entries(a)) {
      if (prop === 'name' || prop.startsWith('xmlns')) continue;
      add(['type', 'base', 'ref', 'minOccurs', 'maxOccurs', 'use', 'nillable', 'default', 'fixed', 'form'].includes(prop) ? 'Schema' : 'Advanced', titleCase(prop), value);
    }
    if (isInstance) {
      add('Schema', 'Min Occurs', node.min); add('Schema', 'Max Occurs', node.max);
      add('Navigation', 'Path', node.path); add('Navigation', 'XPath', node.xpath);
    }
    if (node.documentation) add('Documentation', 'Description', node.documentation);
    function annotations(target: XmlNode, prefix: string): void {
      for (const child of target.children) {
        if (is(child, 'documentation')) continue;
        if (child.uri === XSD && child.local !== 'annotation' && child.local !== 'appinfo') continue;
        const category = child.uri && child.uri !== XSD ? (child.uri.toLowerCase().includes('biztalk') ? 'BizTalk' : 'Annotations') : prefix;
        for (const [p, value] of Object.entries(child.attributes)) {
          if (!p.startsWith('xmlns')) add(category, `${child.local} · ${titleCase(p)}`, value);
        }
        if (child.text.trim()) add(category, child.local, child.text.trim());
        annotations(child, category);
      }
    }
    annotations(n, 'Annotations');
    add('Source', 'File', n.source.name); add('Source', 'Line', String(n.line + 1));
    if (ancestors.has(key(n)) || depth >= 40) {
      node.recursive = true;
      node.warning = depth >= 40 ? 'Expansion stopped at the 40-level depth limit.' : 'Recursive reference — expand its definition in source.';
      add('Schema', 'Expansion', node.warning);
      return node;
    }
    const nextAncestors = new Set(ancestors).add(key(n));
    const append = (child: XmlNode, stack = nextAncestors) => {
      const expanded = expand(child, path, xpath, stack, depth + 1);
      if (expanded) node.children.push(expanded);
    };
    function unresolved(qname: string) {
      node.warning = `Unresolved schema reference: ${qname}`;
      add('Schema', 'Resolution', node.warning);
      warnings.push(`${n.source.name}:${n.line + 1} — ${node.warning}`);
    }
    function contents(target: XmlNode, stack: Set<string>): void {
      if (stack.has(key(target)) && target !== n) {
        node.recursive = true; node.warning = 'Recursive type reference — expansion stops here.';
        add('Schema', 'Expansion', node.warning); return;
      }
      const nestedStack = new Set(stack).add(key(target));
      for (const c of xchildren(target)) {
        if (['annotation', 'selector', 'field', 'key', 'keyref', 'unique', 'assert'].includes(c.local)) {
          if (['key', 'keyref', 'unique', 'assert'].includes(c.local)) add('Constraints', c.local, c.attributes.name || c.attributes.test || 'Defined in source');
          continue;
        }
        if (['complexType', 'simpleType', 'complexContent', 'simpleContent', 'extension', 'restriction'].includes(c.local)) {
          if (c.attributes.base) {
            add('Type', c.local === 'restriction' ? 'Restriction base' : 'Base type', c.attributes.base);
            if (!node.type) node.type = c.attributes.base;
            if (c.local === 'extension') {
              const base = resolve(c, c.attributes.base, ['complexType', 'simpleType']);
              if (base) contents(base, nestedStack); else if (!builtin(c, c.attributes.base)) unresolved(c.attributes.base);
            } else if (!builtin(c, c.attributes.base) && !resolve(c, c.attributes.base, ['simpleType', 'complexType'])) unresolved(c.attributes.base);
          }
          contents(c, nestedStack);
        } else if (['element', 'attribute', 'sequence', 'choice', 'all', 'group', 'attributeGroup', 'any', 'anyAttribute'].includes(c.local)) {
          const expanded = expand(c, path, xpath, nestedStack, depth + 1);
          if (expanded) node.children.push(expanded);
        } else if (c.local === 'list' || c.local === 'union') {
          node.type ||= c.local;
          add('Type', titleCase(c.local), c.attributes.itemType || c.attributes.memberTypes || 'Inline types');
          contents(c, nestedStack);
        } else if (c.attributes.value !== undefined) add('Restrictions', titleCase(c.local), c.attributes.value);
      }
    }
    if (a.ref) {
      const ref = resolve(n, a.ref, [n.local]);
      if (ref) {
        add('Type', 'Definition', `${ref.source.name}:${ref.line + 1}`);
        node.type = ref.attributes.type || `ref ${a.ref}`;
        if (nextAncestors.has(key(ref))) { node.recursive = true; node.warning = 'Recursive reference — expansion stops here.'; }
        else {
          if (ref.attributes.type) {
            const type = resolve(ref, ref.attributes.type, ['complexType', 'simpleType']);
            if (type) contents(type, new Set(nextAncestors).add(key(ref)));
            else if (!builtin(ref, ref.attributes.type)) unresolved(ref.attributes.type);
          }
          contents(ref, nextAncestors);
          node.documentation ||= documentation(ref);
        }
      } else unresolved(a.ref);
    } else if (a.type) {
      const target = resolve(n, a.type, ['complexType', 'simpleType']);
      if (target) contents(target, nextAncestors); else if (!builtin(n, a.type)) unresolved(a.type);
    }
    if (n.local === 'schema') {
      for (const child of xchildren(n).filter(c => ['element', 'attribute', 'complexType', 'simpleType', 'group', 'attributeGroup'].includes(c.local))) append(child);
      add('General', 'Target namespace', doc.namespace || '(none)');
      add('General', 'Element form default', a.elementFormDefault || 'unqualified');
      add('General', 'Attribute form default', a.attributeFormDefault || 'unqualified');
      for (const [prefix, value] of Object.entries(n.namespaces)) add('Namespaces', prefix || '(default)', value);
    } else contents(n, nextAncestors);
    if (n.local === 'element') {
      const hasComplex = (candidate: XmlNode): boolean => xchildren(candidate).some(c => c.local === 'complexType' || hasComplex(c));
      const target = a.type ? resolve(n, a.type, ['complexType']) : a.ref ? resolve(n, a.ref, ['element']) : undefined;
      if (node.children.length || hasComplex(n) || (target && (target.local === 'complexType' || hasComplex(target)))) node.kind = 'record';
      if (!node.type) node.type = node.kind === 'record' ? 'complex' : 'xs:anyType';
      const nodeKind = props.find(p => p.category === 'General' && p.name === 'Node kind');
      if (nodeKind) nodeKind.value = node.kind === 'record' ? 'Record element' : 'Field element';
    }
    // De-duplicate explicit properties and their computed occurrence equivalents.
    node.properties = props.filter((p, i) => props.findIndex(q => q.category === p.category && q.name === p.name && q.value === p.value) === i);
    return node;
  }
  const root = expand(main, '', '', new Set(), 0)!;
  const count = (node: SchemaNode) => { stats.nodes++; if (node.kind === 'record') stats.records++; if (node.kind === 'element') stats.fields++; if (node.kind === 'attribute') stats.attributes++; node.children.forEach(count); };
  count(root);
  return {
    name: source.name, uri: source.uri, namespace: main.attributes.targetNamespace || '', roots: [root],
    warnings: [...new Set(warnings)],
    dependencies: documents.slice(1).map(d => ({ name: d.root.source.name, uri: d.root.source.uri, namespace: d.namespace })), stats
  };
}

export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map(s => `'${s}'`).join(', "\'", ')})`;
}

export function findNode(model: SchemaModel, id: string): SchemaNode | undefined {
  const queue = [...model.roots];
  while (queue.length) { const n = queue.pop()!; if (n.id === id) return n; queue.push(...n.children); }
  return undefined;
}
