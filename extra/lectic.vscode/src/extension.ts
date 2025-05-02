/**
 * Main entry point for the Lectic VS Code extension.
 * This file contains the `activate` and `deactivate` functions,
 * which are called by VS Code when the extension is loaded and unloaded.
 */
import * as vscode from 'vscode';

// Import the command functions from our commands file
import { submitLectic, consolidateLectic, explainSelection } from './commands';
// Import the decoration logic (now includes resetDecorationType)
import { initializeDecorations, updateDecorations, resetDecorationType } from './decorationProvider';
// Import the folding provider
import { LecticFoldingProvider } from './foldingProvider';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {

    console.log('Lectic VS Code extension is now active!');

    // === Register Commands ===
    context.subscriptions.push(vscode.commands.registerCommand('lectic.submit', submitLectic));
    context.subscriptions.push(vscode.commands.registerCommand('lectic.consolidate', consolidateLectic));
    context.subscriptions.push(vscode.commands.registerCommand('lectic.explainSelection', explainSelection));


    // === Register Folding Provider ===
    const lecticDocumentSelector: vscode.DocumentSelector = [
        { language: 'markdown', scheme: 'file', pattern: '**/*.{lec,lectic}' }
    ];
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            lecticDocumentSelector,
            new LecticFoldingProvider()
        )
    );

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
    // The decoration type added to context.subscriptions on activate will be disposed automatically.
}
// --- End file: /home/graham/Projects/lectic/extra/lectic.vscode/src/extension.ts ---