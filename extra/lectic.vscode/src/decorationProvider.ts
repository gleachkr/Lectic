/**
 * Handles the background highlighting for ':::' delimited blocks
 * in 'lectic-markdown' files using VS Code Decorations.
 * Now supports customizable background color via configuration.
 */
import * as vscode from 'vscode';

// Variable to hold the *currently active* decoration type.
// It will be updated when the configuration changes.
let lecticBlockDecorationType: vscode.TextEditorDecorationType | undefined;

/**
 * Reads the configuration and creates a new TextEditorDecorationType
 * based on the user's settings.
 * @returns The created TextEditorDecorationType.
 */
function createDecorationType(): vscode.TextEditorDecorationType {
    // Get the configuration for our extension
    const config = vscode.workspace.getConfiguration('lectic');
    // Retrieve the background color setting, using the default if not set
    const backgroundColorSetting = config.get<string>('blockBackgroundColor'); // Default is defined in package.json

    console.log(`[LecticDebug] Creating decoration type with background: ${backgroundColorSetting}`);

    // Check if the setting looks like a theme color ID (contains '.')
    // VS Code automatically handles theme colors if the string doesn't look like rgba/hex
    // but explicitly creating ThemeColor is safer for IDs. However, letting VS Code parse
    // the string directly might be more flexible for users. Let's try direct parsing first.
    // If issues arise with theme colors, we might need:
    // const isThemeColor = backgroundColorSetting && backgroundColorSetting.includes('.');
    // const finalBackgroundColor = isThemeColor
    //     ? new vscode.ThemeColor(backgroundColorSetting)
    //     : backgroundColorSetting;

    return vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: backgroundColorSetting, // Pass the setting string directly
        // Overview ruler settings remain the same
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
}

/**
 * Disposes the old decoration type (if it exists) and creates/assigns the new one.
 * Should be called on activation and when the configuration changes.
 * @param context - The extension context (needed for initial disposal registration). Optional after activation.
 */
export function resetDecorationType(context?: vscode.ExtensionContext) {
    if (lecticBlockDecorationType) {
        lecticBlockDecorationType.dispose();
        console.log('[LecticDebug] Disposed old decoration type.');
    }
    lecticBlockDecorationType = createDecorationType();
    console.log('[LecticDebug] Created new decoration type.');

    // If context is provided (on initial activation), add the new type to subscriptions
    if (context) {
         context.subscriptions.push(lecticBlockDecorationType);
    }
}


/**
 * Initializes the decoration system on extension activation.
 * @param context The extension context for managing disposables.
 */
export function initializeDecorations(context: vscode.ExtensionContext) {
    // Create the initial decoration type based on current settings
    resetDecorationType(context);
}

/**
 * Finds all ':::' delimited blocks in the given editor's document
 * and applies the *current* Lectic block decoration to them,
 * only if the document is a .lec or .lectic file.
 * @param editor The text editor to apply decorations to.
 */
export function updateDecorations(editor: vscode.TextEditor | undefined) {
    // Check if editor and decoration type are valid
    if (!editor || !lecticBlockDecorationType) {
        // If no decoration type, maybe log a warning? Should have been initialized.
        if (!lecticBlockDecorationType) console.warn('[LecticDebug] updateDecorations called but decoration type is undefined.');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const isLecticFile = filePath && (filePath.endsWith('.lec') || filePath.endsWith('.lectic'));

    if (!isLecticFile) {
        // Clear decorations if it's not a relevant file
        editor.setDecorations(lecticBlockDecorationType, []);
        return;
    }

    // Proceed with decoration logic
    const document = editor.document;
    const decorationsArray: vscode.DecorationOptions[] = [];
    let startLine: number | null = null;

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const line = document.lineAt(lineIndex);
        const lineText = line.text;
        const startMatch = lineText.match(/^:::\s*\S+.*$/);
        const endMatch = lineText.match(/^:::$/);

        if (startMatch) {
            startLine = lineIndex;
        } else if (endMatch && startLine !== null) {
            const range = new vscode.Range(startLine, 0, lineIndex, line.range.end.character);
            decorationsArray.push({ range });
            startLine = null;
        }
    }

    if (startLine !== null) {
        const range = new vscode.Range(startLine, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).range.end.character);
        decorationsArray.push({ range });
    }

    // Apply the *current* decoration type
    editor.setDecorations(lecticBlockDecorationType, decorationsArray);
}

// --- End file: /home/graham/Projects/lectic/extra/lectic.vscode/src/decorationProvider.ts ---
