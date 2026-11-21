import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { buildSchema, parseXml, SchemaModel, SchemaNode, SchemaSource, XSD, xpathLiteral } from '../src/schema';

const source = (body: string, extra = '', uri = 'file:///schemas/test.xsd'): SchemaSource => ({
  uri, name: basename(uri), text: `<xs:schema xmlns:xs="${XSD}" ${extra}>${body}</xs:schema>`
});
const all = (model: SchemaModel): SchemaNode[] => { const walk = (n: SchemaNode): SchemaNode[] => [n, ...n.children.flatMap(walk)]; return model.roots.flatMap(walk); };
const named = (model: SchemaModel, name: string) => { const n = all(model).find(n => n.name === name); assert.ok(n, `Missing node ${name}`); return n; };

test('reads the example, expands imported complex types, and preserves facets and annotations', async () => {
  const path = resolve('examples/PurchaseOrder.xsd');
  const example = await buildSchema({ uri: path, name: basename(path), text: await readFile(path, 'utf8') }, async (parent, location) => {
    const path = resolve(parent.uri, '..', location); return { uri: path, name: basename(path), text: await readFile(path, 'utf8') };
  });
  assert.deepEqual(example.warnings, []);
  assert.equal(example.dependencies.length, 1);
  assert.equal(named(example, 'ShipTo').kind, 'record');
  assert.match(named(example, 'City').xpath, /urn:lambogenius:common/);
  assert.equal(named(example, 'LineItem').max, 'unbounded');
  assert.equal(named(example, 'Notes').min, '0');
  assert.ok(named(example, 'Currency').properties.some(p => p.category === 'Restrictions' && p.value === 'CAD'));
  assert.ok(named(example, 'UnitPrice').properties.some(p => p.name === 'Fraction Digits' && p.value === '2'));
  assert.ok(named(example, 'OrderNumber').properties.some(p => p.category === 'BizTalk' && p.name.includes('Promoted') && p.value === 'true'));
  assert.ok(example.stats.records >= 6);
});

test('namespace URI, rather than prefix, determines schema nodes', async () => {
  const model = await buildSchema({ uri: 'file:///a.xsd', name: 'a.xsd', text: `<schema xmlns="${XSD}" xmlns:other="urn:other"><element name="Root" type="string"/><annotation><appinfo><other:element name="NotAField"/></appinfo></annotation></schema>` });
  assert.equal(named(model, 'Root').type, 'string');
  assert.ok(!all(model).some(n => n.name === 'NotAField'));
  assert.deepEqual(model.warnings, []);
});

test('tracks source offsets and lines through CRLF, comments, and self closing tags', () => {
  const text = `<?xml version="1.0"?>\r\n<!-- test -->\r\n<xs:schema xmlns:xs="${XSD}">\r\n  <xs:element name="Foo" type="xs:string"/>\r\n</xs:schema>`;
  const parsed = parseXml({ uri: 'file:///x.xsd', name: 'x.xsd', text });
  const field = parsed.children[0];
  assert.equal(field.line, 3); assert.equal(field.column, 2);
  assert.equal(text.slice(field.offset, field.endOffset), '<xs:element name="Foo" type="xs:string"/>');
  assert.equal(text.slice(parsed.offset, parsed.endOffset).endsWith('</xs:schema>'), true);
});

test('expands named type extensions and attribute groups', async () => {
  const model = await buildSchema(source(`
    <xs:complexType name="Base"><xs:sequence><xs:element name="A" type="xs:int"/></xs:sequence></xs:complexType>
    <xs:attributeGroup name="Meta"><xs:attribute name="id" use="required" type="xs:ID"/></xs:attributeGroup>
    <xs:complexType name="Child"><xs:complexContent><xs:extension base="t:Base"><xs:sequence><xs:element name="B" type="xs:string"/></xs:sequence><xs:attributeGroup ref="t:Meta"/></xs:extension></xs:complexContent></xs:complexType>
    <xs:element name="Root" type="t:Child"/>`, 'targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified"'));
  const root = named(model, 'Root');
  const fields = all({ ...model, roots: [root] });
  assert.ok(fields.some(n => n.name === 'A')); assert.ok(fields.some(n => n.name === 'B'));
  const id = fields.find(n => n.name === 'id')!; assert.equal(id.min, '1'); assert.match(id.xpath, /namespace-uri\(\)=''/);
  assert.deepEqual(model.warnings, []);
});

test('bounds recursive named types and recursive element references', async () => {
  const model = await buildSchema(source(`<xs:complexType name="Node"><xs:sequence><xs:element name="Child" type="t:Node" minOccurs="0"/></xs:sequence></xs:complexType><xs:element name="Root" type="t:Node"/><xs:element name="Recursive"><xs:complexType><xs:sequence><xs:element ref="t:Recursive" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>`, 'targetNamespace="urn:test" xmlns:t="urn:test"'));
  assert.ok(all(model).some(n => n.recursive)); assert.ok(model.stats.nodes < 30);
  assert.deepEqual(model.warnings, []);
});

test('uses namespaced qualified and unqualified element and attribute XPaths', async () => {
  const model = await buildSchema(source(`<xs:element name="Root"><xs:complexType><xs:sequence><xs:element name="Local" type="xs:string"/><xs:element name="Qualified" type="xs:string" form="qualified"/></xs:sequence><xs:attribute name="id" type="xs:string"/><xs:attribute name="q" type="xs:string" form="qualified"/></xs:complexType></xs:element>`, 'targetNamespace="urn:test"'));
  assert.match(named(model, 'Root').xpath, /namespace-uri\(\)='urn:test'/);
  assert.match(named(model, 'Local').xpath, /local-name\(\)='Local' and namespace-uri\(\)=''/);
  assert.match(named(model, 'Qualified').xpath, /local-name\(\)='Qualified' and namespace-uri\(\)='urn:test'/);
  assert.match(named(model, 'id').xpath, /@\*\[local-name\(\)='id' and namespace-uri\(\)=''/);
  assert.match(named(model, 'q').xpath, /@\*\[local-name\(\)='q' and namespace-uri\(\)='urn:test'/);
});

test('does not silently resolve a QName to the wrong target namespace', async () => {
  const model = await buildSchema(source('<xs:complexType name="Thing"/><xs:element name="Root" type="wrong:Thing"/>', 'xmlns:wrong="urn:wrong" targetNamespace="urn:right"'));
  assert.ok(model.warnings.some(w => w.includes('wrong:Thing')));
});

test('resolves chameleon includes and cyclic include graphs', async () => {
  const main = source('<xs:include schemaLocation="types.xsd"/><xs:element name="Root" type="t:Thing"/>', 'targetNamespace="urn:test" xmlns:t="urn:test"');
  let reads = 0;
  const model = await buildSchema(main, async (_, name) => {
    reads++; if (name === 'main.xsd') return main;
    return source('<xs:include schemaLocation="main.xsd"/><xs:complexType name="Thing"><xs:sequence><xs:element name="Value" type="xs:string"/></xs:sequence></xs:complexType>', '', 'file:///schemas/types.xsd');
  });
  assert.ok(reads < 5); assert.equal(named(model, 'Root').kind, 'record');
  assert.ok(all(model).some(n => n.name === 'Value')); assert.deepEqual(model.warnings, []);
});

test('reports missing imports, namespace mismatches, and unsupported overrides', async () => {
  const missing = await buildSchema(source('<xs:import namespace="urn:foo" schemaLocation="https://example.com/foo.xsd"/><xs:import namespace="urn:bar"/><xs:redefine schemaLocation="a.xsd"/>'));
  assert.equal(missing.warnings.length, 3);
  const mismatch = await buildSchema(source('<xs:include schemaLocation="types.xsd"/>', 'targetNamespace="urn:a"'), async () => source('<xs:element name="Wrong"/>', 'targetNamespace="urn:b"', 'file:///types.xsd'));
  assert.ok(mismatch.warnings[0].includes('different target namespace'));
  assert.ok(!all(mismatch).some(n => n.name === 'Wrong'));
});

test('retains documentation, escaped markup, and flat file annotation properties as text', async () => {
  const model = await buildSchema(source('<xs:element name="Root"><xs:annotation><xs:documentation>&lt;script&gt;alert(1)&lt;/script&gt;</xs:documentation><xs:appinfo><b:fieldInfo xmlns:b="http://schemas.microsoft.com/BizTalk/2003" pos_offset="3" pos_length="10"/></xs:appinfo></xs:annotation></xs:element>'));
  assert.equal(named(model, 'Root').documentation, '<script>alert(1)</script>');
  assert.ok(named(model, 'Root').properties.some(p => p.category === 'BizTalk' && p.value === '10'));
});

test('preserves compositor occurrence counts, wildcard nodes, and prohibited attributes', async () => {
  const model = await buildSchema(source('<xs:element name="Root"><xs:complexType><xs:choice minOccurs="0" maxOccurs="unbounded"><xs:element name="A" type="xs:string"/><xs:any processContents="lax"/></xs:choice><xs:attribute name="old" use="prohibited"/><xs:anyAttribute/></xs:complexType></xs:element>'));
  const choice = named(model, 'choice'); assert.equal(choice.min, '0'); assert.equal(choice.max, 'unbounded');
  assert.equal(named(model, 'old').max, '0'); assert.equal(named(model, 'anyAttribute').kind, 'any');
});

test('rejects malformed XML, wrong roots, DOCTYPE, entities, oversized files and deep nesting', async () => {
  await assert.rejects(buildSchema(source('<xs:element>')), /close|unexpected/i);
  await assert.rejects(buildSchema({ uri: 'x', name: 'x', text: '<schema/>' }), /Expected an XML Schema/);
  await assert.rejects(buildSchema({ uri: 'x', name: 'x', text: '<!DOCTYPE schema [<!ENTITY x SYSTEM "file:///secret">]><schema/>' }), /DOCTYPE/);
  await assert.rejects(buildSchema(source('<xs:element name="&unknown;"/>')), /entity/i);
  await assert.rejects(buildSchema(source(' '.repeat(4 * 1024 * 1024))), /4 MB/);
  await assert.rejects(buildSchema(source('<xs:sequence>'.repeat(260) + '</xs:sequence>'.repeat(260))), /256/);
});

test('escapes XPath string literals with both quote styles', () => {
  assert.equal(xpathLiteral('abc'), "'abc'");
  assert.equal(xpathLiteral("a'b"), '"a\'b"');
  assert.equal(xpathLiteral('a\'b"c'), 'concat(\'a\', "\'", \'b"c\')');
});
