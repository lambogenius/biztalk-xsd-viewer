import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

await build({ entryPoints: ['src/schema.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: '.test-temp/schema.cjs' });
const { buildSchema } = createRequire(import.meta.url)('../.test-temp/schema.cjs');
const main = resolve('examples/PurchaseOrder.xsd');
const sources = new Map();
async function read(path) { const source = { uri: path, name: basename(path), text: await readFile(path, 'utf8') }; sources.set(path, source); return source; }
const model = await buildSchema(await read(main), (parent, location) => read(resolve(dirname(parent.uri), location)));
const allNodes = [];
const walk = n => { allNodes.push(n); n.children.forEach(walk); }; model.roots.forEach(walk);
const harness = `window.__messages=[];window.__model=${JSON.stringify(model).replace(/</g, '\\u003c')};window.__sources=${JSON.stringify(Object.fromEntries(sources)).replace(/</g, '\\u003c')};window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:state=>window.__state=state,postMessage:message=>{window.__messages.push(message);if(message.type==='ready')setTimeout(()=>window.postMessage({type:'model',model:window.__model},'*'),0);if(message.type==='selection'){const find=n=>n.id===message.id?n:n.children.map(find).find(Boolean);const n=window.__model.roots.map(find).find(Boolean);if(n)setTimeout(()=>window.postMessage({type:'snippet',id:n.id,text:window.__sources[n.sourceUri].text.slice(n.offset,n.endOffset),line:n.line+1,name:window.__sources[n.sourceUri].name},'*'),0)}}});`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'nonce-test'; img-src 'self' data:;"><link rel="stylesheet" href="/viewer.css"></head><body class="vscode-dark"><div id="app"></div><script nonce="test">${harness}</script><script nonce="test" src="/viewer.js"></script></body></html>`); }
    else if (['/viewer.css', '/viewer.js'].includes(req.url)) { res.setHeader('Content-Type', req.url.endsWith('css') ? 'text/css' : 'text/javascript'); res.end(await readFile(resolve('media', req.url.slice(1)))); }
    else if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); }
    else { res.statusCode = 404; res.end(); }
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  // Reuse the machine's browser; no browser download or existing user profile is needed.
  browser = await chromium.launch({ channel: process.env.XSD_TEST_BROWSER || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1340, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: 'Schema Viewer', exact: true }).waitFor();
  assert.equal(await page.getByRole('tree').count(), 1);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  assert.ok(await page.getByRole('treeitem').count() > 25);
  const orderNumber = page.getByRole('treeitem').filter({ has: page.locator('.node-name', { hasText: /^OrderNumber$/ }) });
  await orderNumber.click();
  await page.locator('#source-meta').filter({ hasText: 'PurchaseOrder.xsd' }).waitFor();
  assert.match(await page.locator('.properties').innerText(), /Promoted/);
  assert.match(await page.locator('#source-code').innerText(), /OrderNumber/);
  await page.getByRole('button', { name: 'Copy XPath', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__messages.at(-1).type), 'copyPath');
  await page.getByRole('button', { name: 'Open source', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__messages.at(-1).type), 'source');
  await page.getByRole('searchbox').fill('PostalCode');
  assert.match(await page.getByRole('tree').innerText(), /ShipTo/);
  assert.match(await page.getByRole('tree').innerText(), /PostalCode/);
  assert.doesNotMatch(await page.getByRole('tree').innerText(), /OrderNumber/);
  await page.getByRole('searchbox').fill('no-such-field'); await page.getByText('No matching nodes', { exact: true }).waitFor();
  await page.getByRole('searchbox').fill('');
  await page.getByRole('checkbox', { name: 'Show compositors' }).check();
  assert.ok(await page.locator('.kind-sequence').count() > 0);
  await page.getByRole('checkbox', { name: 'Show compositors' }).uncheck();
  const notes = page.getByRole('treeitem').filter({ has: page.locator('.node-name', { hasText: /^Notes$/ }) });
  await notes.click(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.tree-row[aria-selected="true"] .node-name').innerText(), 'orderId');
  await page.keyboard.press('Home'); assert.equal(await page.locator('.tree-row[aria-selected="true"] .node-name').innerText(), 'PurchaseOrder.xsd');
  await page.keyboard.press('ArrowLeft'); assert.equal(await page.getByRole('treeitem').count(), 1);
  await page.keyboard.press('ArrowRight'); assert.ok(await page.getByRole('treeitem').count() > 1);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page.getByRole('treeitem').filter({ has: page.locator('.node-name', { hasText: /^LineItem$/ }) }).click();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/schema-viewer-dark.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false);
  await page.evaluate(() => { document.body.className = 'vscode-light'; document.documentElement.style.setProperty('--bg', '#ffffff'); document.documentElement.style.setProperty('--fg', '#30333b'); document.documentElement.style.setProperty('--muted', '#686d7b'); document.documentElement.style.setProperty('--panel', '#f7f8fa'); document.documentElement.style.setProperty('--border', '#e3e5e9'); document.documentElement.style.setProperty('--input', '#ffffff'); document.documentElement.style.setProperty('--hover', '#eef0f4'); document.documentElement.style.setProperty('--selected', '#eee8fa'); document.documentElement.style.setProperty('--selected-fg', '#432c69'); });
  await page.screenshot({ path: 'artifacts/schema-viewer-light.png', fullPage: true });
  await page.setViewportSize({ width: 760, height: 750 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 420, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/schema-viewer-narrow.png', fullPage: true });
  // Untrusted documentation and property values must stay text, even with script markup.
  await page.evaluate(() => {
    const model = structuredClone(window.__model); const target = model.roots[0].children[0];
    target.documentation = '<img src=x onerror="window.__injected=true">';
    target.properties.push({ category: 'BizTalk', name: '<script>alert(1)</script>', value: '<iframe src="https://example.com">' });
    window.postMessage({ type: 'model', model }, '*');
  });
  await page.getByRole('treeitem').filter({ has: page.locator('.node-name', { hasText: /^PurchaseOrder$/ }) }).click();
  assert.equal(await page.locator('.documentation img, .properties iframe, .properties script').count(), 0);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await page.evaluate(() => window.postMessage({ type: 'error', name: 'broken.xsd', message: 'Malformed XML on line 4' }, '*'));
  await page.getByRole('heading', { name: 'Unable to read this schema' }).waitFor();
  assert.equal(await page.getByRole('tree').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Webview checks passed: rendering, source messages, search, imported types, compositors, keyboard, themes, narrow layouts, error state, and content escaping.');
} finally { await browser?.close(); server.close(); }
