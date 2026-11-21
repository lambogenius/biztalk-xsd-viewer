import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { buildSchema, findNode, SchemaModel, SchemaSource } from './schema';

const VIEW_TYPE = 'lambogenius.xsdViewer';
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new SchemaEditor(context), {
      webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true
    }),
    vscode.commands.registerCommand('xsdViewer.open', async (resource?: vscode.Uri) => {
      let uri = resource;
      if (!uri && vscode.window.activeTextEditor?.document.uri.path.toLowerCase().endsWith('.xsd')) uri = vscode.window.activeTextEditor.document.uri;
      if (!uri) [uri] = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'XML Schema': ['xsd'] }, title: 'Open an XSD schema' }) || [];
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('xsdViewer.openExample', async () => {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'examples', 'PurchaseOrder.xsd'), VIEW_TYPE);
    })
  );
}

class SchemaEditor implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = this.html(panel.webview);
    let model: SchemaModel | undefined;
    let sources = new Map<string, SchemaSource>();
    let generation = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      const run = ++generation;
      const loaded = new Map<string, SchemaSource>();
      const read = async (uri: vscode.Uri): Promise<SchemaSource> => {
        const cached = loaded.get(uri.toString());
        if (cached) return cached;
        const openDocument = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        let text: string;
        if (openDocument) text = openDocument.getText();
        else {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > 4 * 1024 * 1024) throw new Error('Schema exceeds the 4 MB per-file limit.');
          const bytes = await vscode.workspace.fs.readFile(uri);
          // XML schemas commonly use UTF-8; TextDecoder also supports a UTF-16 BOM.
          const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
          text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        }
        const source = { uri: uri.toString(), name: posix.basename(uri.path), text };
        loaded.set(source.uri, source);
        return source;
      };
      try {
        const primary = await read(document.uri);
        const result = await buildSchema(primary, async (parent, location) => {
          // Do not follow remote URLs, absolute paths, query strings, or another provider.
          if (/^[a-z][a-z\d+.-]*:|^[\\/]|[?#]/i.test(location)) return undefined;
          let relative: string;
          try { relative = decodeURIComponent(location).replace(/\\/g, '/'); } catch { return undefined; }
          if (/^[a-z][a-z\d+.-]*:|^[\/]|[\0?#]/i.test(relative)) return undefined;
          const parentUri = vscode.Uri.parse(parent.uri);
          const uri = vscode.Uri.joinPath(parentUri, '..', relative);
          if (uri.scheme !== document.uri.scheme || uri.authority !== document.uri.authority) return undefined;
          // Includes can use ../, but must remain inside an open workspace or the schema's folder.
          const scope = vscode.workspace.getWorkspaceFolder(document.uri)?.uri || vscode.Uri.joinPath(document.uri, '..');
          const normalize = (value: string) => uri.scheme === 'file' && process.platform === 'win32' ? value.toLowerCase() : value;
          const base = normalize(scope.path.replace(/\/$/, ''));
          const target = normalize(uri.path);
          if (target !== base && !target.startsWith(`${base}/`)) return undefined;
          return read(uri);
        });
        if (disposed || run !== generation) return;
        model = result; sources = loaded;
        await panel.webview.postMessage({ type: 'model', model });
      } catch (error) {
        if (disposed || run !== generation) return;
        model = undefined; sources.clear();
        await panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error), name: posix.basename(document.uri.path) });
      }
    };
    const scheduleUpdate = () => { clearTimeout(timer); timer = setTimeout(() => void update(), 180); };
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === document.uri.toString() || sources.has(event.document.uri.toString())) scheduleUpdate();
      }),
      vscode.workspace.onDidSaveTextDocument(changed => { if (sources.has(changed.uri.toString())) scheduleUpdate(); }),
      panel.onDidChangeViewState(event => { if (event.webviewPanel.visible) scheduleUpdate(); }),
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        const input = message as { type: string; id?: unknown; value?: unknown };
        try {
          if (input.type === 'ready' || input.type === 'refresh') { await update(); return; }
          const node = model && typeof input.id === 'string' ? findNode(model, input.id) : undefined;
          if (input.type === 'source') {
            const uri = node ? vscode.Uri.parse(node.sourceUri) : document.uri;
            if (node && !sources.has(node.sourceUri)) return;
            const sourceDocument = await vscode.workspace.openTextDocument(uri);
            const start = new vscode.Position(node?.line || 0, node?.column || 0);
            const editor = await vscode.window.showTextDocument(sourceDocument, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false, selection: new vscode.Range(start, start), preview: true });
            editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          } else if (input.type === 'copyPath' && node) {
            await vscode.env.clipboard.writeText(node.xpath);
            await panel.webview.postMessage({ type: 'copied' });
          } else if (input.type === 'selection' && node) {
            const source = sources.get(node.sourceUri);
            if (!source) return;
            const text = source.text.slice(node.offset, Math.min(node.endOffset, node.offset + 10000));
            const lines = text.split(/\r?\n/);
            await panel.webview.postMessage({ type: 'snippet', id: node.id, text: lines.slice(0, 60).join('\n'), line: node.line + 1, name: source.name, truncated: lines.length > 60 || node.endOffset - node.offset > 10000 });
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`XSD Viewer: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    ];
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.getWorkspaceFolder(document.uri)?.uri || vscode.Uri.joinPath(document.uri, '..'), '**/*.{xsd,XSD}'));
    const onFile = (uri: vscode.Uri) => { if (sources.has(uri.toString()) || uri.toString() === document.uri.toString() || model?.warnings.length) scheduleUpdate(); };
    subscriptions.push(watcher, watcher.onDidChange(onFile), watcher.onDidCreate(onFile), watcher.onDidDelete(onFile));
    panel.onDidDispose(() => { disposed = true; generation++; clearTimeout(timer); subscriptions.forEach(s => s.dispose()); });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.js'));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}"><title>XSD Schema Viewer</title></head><body>
<div id="app" aria-busy="true"><div class="loading"><span class="loading-mark">X</span><p>Reading schema…</p></div></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
