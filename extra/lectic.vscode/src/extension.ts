/**
 * Main entry point for the Lectic VS Code extension.
 * This file contains the `activate` and `deactivate` functions,
 * which are called by VS Code when the extension is loaded and unloaded.
 */
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

// Import the command functions from our commands file
import { submitLectic, explainSelection } from './commands';
// Import the decoration logic (now includes resetDecorationType)
import { initializeDecorations, updateDecorations, resetDecorationType } from './decorationProvider';
// LSP now provides folding; built-in folding provider removed.
// If needed as a fallback, re-introduce a minimal provider
// and gate it behind a setting.

let client: LanguageClient | undefined;

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {

    console.log('Lectic VS Code extension is now active!');

    // === Register Commands ===
    context.subscriptions.push(vscode.commands.registerCommand('lectic.submit', submitLectic));
    context.subscriptions.push(vscode.commands.registerCommand('lectic.explainSelection', explainSelection));

    // === Start Lectic LSP client ===
    const serverOptions = {
        command: 'lectic',
        args: ['lsp'],
        options: { } // stdio is default for Executable
    };
    const clientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'markdown' },
            { scheme: 'file', pattern: '**/*.lec' },
            { scheme: 'file', pattern: '**/*.lectic' },
        ],
        synchronize: {
            configurationSection: 'lectic'
        }
    };
    client = new LanguageClient('lectic', 'Lectic LSP', serverOptions as any, clientOptions);
    await client.start();
    // Ensure the client stops when the extension is disposed
    context.subscriptions.push(new vscode.Disposable(() => {
        if (client) {
            void client.stop();
        }
    }));

    // === Initialize Decorations ===
    initializeDecorations(context); // Creates the initial decoration type

    // Trigger initial update for active editor
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }

    // === Event Listeners for Decorations ===
    // Update on editor change
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                updateDecorations(editor);
            }
        }, null, context.subscriptions)
    );

    // Update on text change (debounced)
    let timeout: NodeJS.Timeout | undefined = undefined;
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
                if (timeout) clearTimeout(timeout);
                timeout = setTimeout(() => {
                    updateDecorations(vscode.window.activeTextEditor!); // updateDecorations checks file type
                }, 500);
            }
        }, null, context.subscriptions)
    );

    // --- ADDED: Listen for configuration changes ---
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            // Check if *our* specific setting for background color was affected
            if (event.affectsConfiguration('lectic.blockBackgroundColor')) {
                console.log('[LecticDebug] Configuration changed: lectic.blockBackgroundColor');
                // Re-create the decoration type with the new setting
                resetDecorationType(); // Don't pass context here, it's only needed on activation
                // Re-apply decorations to all visible editors
                vscode.window.visibleTextEditors.forEach(editor => {
                    updateDecorations(editor);
                });
            }
        }, null, context.subscriptions)
    );

}

// This method is called when your extension is deactivated
export function deactivate() {
    console.log('Lectic VS Code extension deactivated.');
    if (client) {
        client.stop();
    }
    // The decoration type added to context.subscriptions on activate will be disposed automatically.
}
// --- End file: /home/graham/Projects/lectic/extra/lectic.vscode/src/extension.ts ---
