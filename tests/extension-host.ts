import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('Lambogenius.biztalk-xsd-viewer');
  assert.ok(extension, 'Extension must be discovered');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('xsdViewer.open')); assert.ok(commands.includes('xsdViewer.openExample'));
  await vscode.commands.executeCommand('xsdViewer.openExample');
  let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab?.input instanceof vscode.TabInputCustom, 'Example opens in a custom editor');
  assert.equal(tab.input.viewType, 'lambogenius.xsdViewer');
  assert.ok(tab.input.uri.path.endsWith('/examples/PurchaseOrder.xsd'));
  const source = await vscode.workspace.openTextDocument(vscode.Uri.file(join(extension.extensionPath, 'examples/CommonTypes.xsd')));
  await vscode.commands.executeCommand('xsdViewer.open', source.uri);
  tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab?.input instanceof vscode.TabInputCustom); assert.ok(tab.input.uri.path.endsWith('CommonTypes.xsd'));
  // Open the document as text alongside the viewer, as the Reveal in source action does.
  const text = await vscode.window.showTextDocument(source, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(4, 6, 4, 6) });
  assert.equal(text.document.uri.toString(), source.uri.toString()); assert.equal(text.selection.start.line, 4);
  console.log('Extension host checks passed: activation, commands, example, custom editor, and source document.');
}
