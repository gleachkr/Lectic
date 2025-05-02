/**
 * Contains the implementations for the commands exposed by the extension,
 * primarily interacting with the 'lectic' command-line tool.
 * Includes enhanced debugging logs and serialized streaming output for submitLectic.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process'; // Node.js child process module
import * as os from 'os'; // Node.js operating system module
import * as path from 'path'; // Node.js path module

// Import shared functions
import { updateDecorations } from './decorationProvider';

// --- Helper function for logging ---
function logDebug(message: string, ...optionalParams: any[]) {
    // Prefix logs for easy filtering in the console
    console.log(`[LecticDebug] ${message}`, ...optionalParams);
}

/**
 * Retrieves the configured path to the lectic executable.
 * @returns The path to the lectic executable or 'lectic' if not configured.
 */
function getLecticExecutablePath(): string {
    const config = vscode.workspace.getConfiguration('lectic');
    const executablePath = config.get<string>('executablePath', 'lectic');
    logDebug(`Using lectic executable path: ${executablePath}`);
    return executablePath;
}

/**
 * Checks if the lectic executable is available.
 * Shows an error message if not found.
 * @returns True if lectic is found, false otherwise.
 */
async function checkLecticExists(): Promise<boolean> {
    const lecticPath = getLecticExecutablePath();
    const checkCommand = os.platform() === 'win32' ? `where "${lecticPath}"` : `command -v "${lecticPath}"`;
    logDebug(`Checking lectic existence with command: ${checkCommand}`);
    try {
        await new Promise((resolve, reject) => {
            cp.exec(checkCommand, (error, stdout, stderr) => {
                if (error) {
                    logDebug(`checkLecticExists cp.exec error:`, error);
                    if(stderr) {
                        logDebug(`checkLecticExists cp.exec stderr: ${stderr}`);
                    }
                    if (!stdout) { // If stdout is empty, it likely failed
                         reject(error || new Error(`Command failed: ${checkCommand}`));
                         return;
                    }
                     // Fallthrough: command succeeded even with error object (e.g., stderr output on success in some shells)
                }
                logDebug(`checkLecticExists cp.exec stdout: ${stdout}`);
                resolve(stdout);
            });
        });
        logDebug(`Lectic executable check successful.`);
        return true;
    } catch (error) {
        vscode.window.showErrorMessage(
            `Error: '${lecticPath}' binary not found or check failed. Please install lectic or configure 'lectic.executablePath'. Check Developer Tools Console (Help > Toggle Developer Tools) for details.`
        );
        logDebug(`Failed to find lectic or check failed:`, error);
        return false;
    }
}

/**
 * Gets the appropriate working directory for the lectic process.
 * Prefers the workspace folder containing the active document,
 * falls back to the directory of the document itself, or the user's home directory.
 * @param document The active text document.
 * @returns The calculated current working directory path.
 */
function getWorkingDirectory(document: vscode.TextDocument): string {
    let cwd: string | undefined;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (workspaceFolder) {
        cwd = workspaceFolder.uri.fsPath;
        logDebug(`Using workspace folder as CWD: ${cwd}`);
    } else if (document.uri.scheme === 'file') {
        cwd = path.dirname(document.uri.fsPath);
        logDebug(`Using document directory as CWD: ${cwd}`);
    } else {
        cwd = os.homedir();
        logDebug(`Falling back to home directory as CWD: ${cwd}`);
    }
    return cwd;
}


/**
 * Command: lectic.submit
 * Sends the current buffer content to 'lectic -s', streams the output
 * back into the editor using a serialized queue.
 */
export async function submitLectic() {
    logDebug("Command 'lectic.submit' triggered.");
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logDebug('No active editor found.');
        vscode.window.showInformationMessage('No active editor found.');
        return;
    }

    if (!(await checkLecticExists())) {
        logDebug('checkLecticExists failed, aborting.');
        return; // Stop if lectic is not found
    }

    const document = editor.document;
    const lecticPath = getLecticExecutablePath();
    const initialContent = document.getText();
    let lineCount = document.lineCount; // Initial line count

    // --- Prepare buffer (add trailing newline if needed) ---
    logDebug('Ensuring buffer ends with a newline before execution...');
    let initialEditSuccess = await editor.edit(editBuilder => {
        let needsTrailingNewline = true;
        if (lineCount > 0 && document.lineAt(lineCount - 1).isEmptyOrWhitespace) {
            needsTrailingNewline = false;
        }
        if (needsTrailingNewline) {
            logDebug('Adding trailing newline before sending.');
            editBuilder.insert(document.positionAt(initialContent.length), '\n');
        } else {
             logDebug('Buffer already ends with blank line, no initial edit needed.');
        }
        // Also always insert a newline to ensure a completely blank line before the :::
        editBuilder.insert(document.positionAt(initialContent.length), '\n');
    }, { undoStopBefore: true, undoStopAfter: true }); // Separate undo step


    if (!initialEditSuccess) {
         logDebug('Failed to apply initial newline edit.');
         vscode.window.showErrorMessage('Failed to prepare buffer for lectic.');
         return;
    }

    // --- Setup for streaming ---
    const contentToSend = document.getText(); // Get fresh content
    lineCount = document.lineCount; // Update line count
    const insertionLineIndex = lineCount - 1;
    let currentInsertPosition = document.lineAt(insertionLineIndex).range.end; // Start at end of last line
    logDebug(`Insertion will start at line index: ${insertionLineIndex}, position: ${currentInsertPosition.line}:${currentInsertPosition.character}`);
    logDebug(`Content length to send: ${contentToSend.length}`);

    const status = vscode.window.setStatusBarMessage(`$(sync~spin) Running lectic...`);
    const commandArgs = ['-s'];
    const cwd = getWorkingDirectory(document);
    const spawnOptions: cp.SpawnOptions = { cwd: cwd, env: process.env };

    // --- Queueing mechanism for stdout chunks ---
    const chunkQueue: string[] = [];
    let isProcessingEdit = false;
    let firstChunkProcessed = false;
    let lecticProcessClosed = false;
    let activeEditPromise: Promise<void> | null = null; // To track ongoing edits

    /** Processes the next chunk from the queue if not already busy. */
    const processChunkQueue = async () => {
        if (isProcessingEdit || chunkQueue.length === 0) {
            // If busy or queue empty, exit. If process closed AND queue empty, apply final undo stop.
             if (lecticProcessClosed && chunkQueue.length === 0 && !isProcessingEdit) {
                logDebug('Process closed and queue empty, applying final undo stop.');
                try {
                   await editor.edit(_ => { /* No-op */ }, { undoStopBefore: false, undoStopAfter: true });
                   logDebug('Applied final undo stop.');
                } catch(e: any) { logDebug('Error applying final undo stop:', e?.message); }
            }
            return;
        }

        isProcessingEdit = true;
        activeEditPromise = (async () => { // Wrap the async work
            const chunkText = chunkQueue.shift()!; // Take next chunk
            logDebug(`Processing chunk from queue (${chunkText.length} chars)`);

            try {
                const editSuccess = await editor.edit(editBuilder => {
                    logDebug(`  Applying edit to insert chunk at ${currentInsertPosition.line}:${currentInsertPosition.character}`);
                    editBuilder.insert(currentInsertPosition, chunkText);
                }, { undoStopBefore: !firstChunkProcessed, undoStopAfter: false }); // Start undo group on first chunk

                if (editSuccess) {
                    firstChunkProcessed = true; // Mark that we've started the potential undo group
                    // Update insert position *carefully* based on the document *after* the edit
                    currentInsertPosition = editor.document.lineAt(editor.document.lineCount - 1).range.end;
                    logDebug(`  Edit successful. New insert position approx: ${currentInsertPosition.line}:${currentInsertPosition.character}`);

                    // Reveal the current insertion point
                    editor.revealRange(
                        new vscode.Range(currentInsertPosition, currentInsertPosition),
                        vscode.TextEditorRevealType.Default
                    );
                } else {
                    logDebug('  Edit application failed for chunk.');
                    vscode.window.showWarningMessage('Failed to apply intermediate edit from lectic.');
                    // Don't update position if edit failed!
                }
            } catch (editError: any) {
                logDebug(`  Error during editor.edit for chunk: ${editError.message}`);
                vscode.window.showErrorMessage(`Error applying streamed edit: ${editError.message}`);
                // Stop processing queue on error? Or just log and continue? For now, log and continue.
            } finally {
                isProcessingEdit = false;
                activeEditPromise = null; // Clear the promise tracker
                // Schedule next chunk processing (use setTimeout to yield execution briefly)
                setTimeout(processChunkQueue, 0);
            }
        })();
    };

    logDebug(`Spawning lectic process...`);
    logDebug(`  Executable: ${lecticPath}`);
    logDebug(`  Arguments: ${JSON.stringify(commandArgs)}`);
    logDebug(`  Options: ${JSON.stringify({ cwd: spawnOptions.cwd, env: 'process.env' })}`);

    try {
        const lecticProcess = cp.spawn(lecticPath, commandArgs, spawnOptions);

        if (!lecticProcess.stdin || !lecticProcess.stdout || !lecticProcess.stderr) {
            logDebug('Critical Error: Standard IO streams not available on lectic process.');
            status.dispose();
            vscode.window.showErrorMessage('Failed to get standard IO streams for lectic process.');
            lecticProcess.removeAllListeners();
            return;
        }

        let errorData = '';

        // --- Stderr Handling ---
        lecticProcess.stderr.on('data', (dataChunk: Buffer) => {
            const chunk = dataChunk.toString();
            logDebug(`stderr chunk received (${chunk.length} chars): "${chunk.replace(/\n/g, '\\n')}"`);
            errorData += chunk;
            console.error(`[LecticStderr] ${chunk}`);
        });

        // --- Stdout Queueing Handling ---
        lecticProcess.stdout.on('data', (dataChunk: Buffer) => {
             const chunkText = dataChunk.toString();
             logDebug(`stdout chunk received (${chunkText.length} chars), adding to queue.`);
             chunkQueue.push(chunkText);
             processChunkQueue(); // Trigger queue processing
        });

        // --- Process End Handling ---
        lecticProcess.on('error', (err) => {
            status.dispose();
            vscode.window.showErrorMessage(`Failed to start lectic process: ${err.message}.`);
            logDebug(`'error' event on lectic process:`, err);
             lecticProcessClosed = true; // Ensure final checks run
             processChunkQueue(); // Check if final undo stop needs applying
        });

        lecticProcess.on('close', async (code, signal) => {
            status.dispose();
            logDebug(`'close' event on lectic process. Code: ${code}, Signal: ${signal}`);
            logDebug(`  Final accumulated stderr length: ${errorData.length}`);
            lecticProcessClosed = true;

            // Wait for any potentially ongoing edit to finish before final checks/updates
            if (activeEditPromise) {
                logDebug('Waiting for last active edit promise to settle...');
                await activeEditPromise.catch(e => logDebug('Error in last active edit:', e)); // Catch potential error from last edit
                logDebug('Last active edit promise settled.');
            }

            // Final check to process queue and apply undo stop if needed
            processChunkQueue();

            if (signal) {
                 vscode.window.showErrorMessage(`Lectic process terminated by signal: ${signal}`);
                 logDebug(`Process terminated by signal: ${signal}`);
                 return;
            }

            if (code !== 0) {
                const displayError = errorData || 'Unknown error (no stderr output)';
                vscode.window.showErrorMessage(`Lectic exited with error code ${code}: ${displayError}. Output may be incomplete.`);
                logDebug(`Lectic process exited with error code ${code}. stderr content: "${errorData}"`);
                return;
            }

            // --- Success Case (code === 0) ---
            logDebug('Lectic process completed successfully (code 0).');
            if (!firstChunkProcessed) { // Use flag instead of receivedAnyData
                logDebug('Lectic returned no output, but exited successfully.');
                vscode.window.showInformationMessage('Lectic returned no output.');
            }

            // --- Auto-fold based on configuration --- 
            const shouldAutoFold = vscode.workspace.getConfiguration('lectic').get<boolean>('autoFoldToolCalls', false); // Default false from package.json
            if (shouldAutoFold && firstChunkProcessed) { // Only fold if we actually inserted something
                 logDebug('Auto-folding enabled, executing foldAll command...');
                 try {
                     // Allow brief moment for folding provider/rendering to potentially update
                     await new Promise(resolve => setTimeout(resolve, 150)); 
                     // --- CHANGED: Use editor.foldAll --- 
                     await vscode.commands.executeCommand('editor.foldAll');
                     logDebug('Executed foldAll command.');
                 } catch (foldError: any) {
                     logDebug(`Error executing fold command: ${foldError.message}`);
                     // Don't bother the user with folding errors usually
                 }
            }
            // --- End Auto-fold section ---

            // Final decoration update
            logDebug('Updating decorations post-process.');
            updateDecorations(editor);
        });

        // --- Write to Stdin ---
        logDebug('Writing content to lectic stdin...');
        lecticProcess.stdin!.write(contentToSend, (err) => {
            if (err) {
                logDebug(`Error writing to stdin:`, err);
                 vscode.window.showErrorMessage(`Failed to write to lectic stdin: ${err.message}`);
            } else {
                logDebug('Finished writing to stdin.');
            }
            logDebug('Closing lectic stdin.');
            lecticProcess.stdin!.end();
        });

    } catch (error: any) {
        status.dispose();
        vscode.window.showErrorMessage(`Error setting up lectic process: ${error.message}.`);
        logDebug(`Error caught during lectic process setup/spawn:`, error);
    }
}

/**
 * Command: lectic.consolidate
 * Replaces the entire buffer with the output of 'lectic --consolidate'.
 * Sends current buffer content to stdin.
 */
export async function consolidateLectic() {
    logDebug("Command 'lectic.consolidate' triggered.");
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logDebug('No active editor found.');
        vscode.window.showInformationMessage('No active editor found.');
        return;
    }
     if (!(await checkLecticExists())) {
        logDebug('checkLecticExists failed, aborting.');
        return; // Stop if lectic is not found
    }

    const document = editor.document;
    const lecticPath = getLecticExecutablePath();
    const status = vscode.window.setStatusBarMessage(`$(sync~spin) Running lectic --consolidate...`);
    const commandArgs = ['--consolidate'];
    const cwd = getWorkingDirectory(document);
    const spawnOptions: cp.SpawnOptions = { cwd: cwd, env: process.env };

    // --- Get current content BEFORE spawning --- 
    const contentToSend = document.getText();
    logDebug(`Consolidate: Content length to send: ${contentToSend.length}`);

    logDebug(`Spawning lectic process for consolidate...`);
    logDebug(`  Executable: ${lecticPath}`);
    logDebug(`  Arguments: ${JSON.stringify(commandArgs)}`);
    logDebug(`  Options: ${JSON.stringify({ cwd: spawnOptions.cwd, env: 'process.env' })}`);

    try {
        const process = cp.spawn(lecticPath, commandArgs, spawnOptions);

        if (!process.stdin || !process.stdout || !process.stderr) {
            logDebug('Critical Error: Standard IO streams not available on consolidate process.');
            status.dispose();
            vscode.window.showErrorMessage('Failed to get standard IO streams for lectic consolidate.');
            process.removeAllListeners();
            return;
        }

        let outputData = '';
        let errorData = '';

        process.stdout.on('data', (dataChunk: Buffer) => {
             const chunk = dataChunk.toString();
             logDebug(`consolidate stdout chunk (${chunk.length} chars)`);
             outputData += chunk;
        });
        process.stderr.on('data', (dataChunk: Buffer) => {
            const chunk = dataChunk.toString();
             logDebug(`consolidate stderr chunk (${chunk.length} chars)`);
             errorData += chunk;
             console.error(`[LecticStderr-Consolidate] ${chunk}`);
        });

        process.on('error', (err) => {
             status.dispose();
             vscode.window.showErrorMessage(`Failed to start lectic --consolidate: ${err.message}.`);
             logDebug(`'error' event on consolidate process:`, err);
        });

        process.on('close', async (code, signal) => {
            status.dispose();
            logDebug(`'close' event on consolidate process. Code: ${code}, Signal: ${signal}`);
            logDebug(`  Final accumulated stdout length: ${outputData.length}`);
            logDebug(`  Final accumulated stderr length: ${errorData.length}`);

             if (signal) {
                 vscode.window.showErrorMessage(`Lectic consolidate process terminated by signal: ${signal}`);
                 logDebug(`Consolidate process terminated by signal: ${signal}`);
                 return;
             }
            if (code !== 0) {
                 const displayError = errorData || 'Unknown error (no stderr output)';
                 vscode.window.showErrorMessage(`Lectic --consolidate failed (code ${code}): ${displayError}.`);
                 logDebug(`Consolidate process exited with error code ${code}. stderr content: "${errorData}"`);
                return;
            }

            logDebug('Consolidate completed successfully. Replacing document content.');
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length) // Use current length AFTER process finished
            );
            
            const success = await editor.edit(editBuilder => {
                 editBuilder.replace(fullRange, outputData);
            }, { undoStopBefore: true, undoStopAfter: true }); // Single undo step for consolidate

            logDebug(`Consolidate edit applied: ${success}`);

            if (!success) {
                vscode.window.showErrorMessage('Failed to apply consolidation edit.');
                logDebug('Consolidate edit application failed.');
            } else {
                 // Use document line count *after* the edit for cursor positioning
                 const finalLineCount = editor.document.lineCount;
                 const newLastLine = editor.document.lineAt(finalLineCount > 0 ? finalLineCount - 1 : 0);
                 editor.selection = new vscode.Selection(newLastLine.range.end, newLastLine.range.end);
                 editor.revealRange(newLastLine.range);
                 logDebug('Updating decorations after consolidate.');
                 updateDecorations(editor);
            }
        });

        // --- Write content to stdin --- 
        logDebug('Writing current document content to lectic --consolidate stdin...');
        process.stdin!.write(contentToSend, (err) => {
             if (err) {
                logDebug(`Error writing consolidate content to stdin:`, err);
                 vscode.window.showErrorMessage(`Failed to write to lectic consolidate stdin: ${err.message}`);
             } else {
                logDebug('Finished writing consolidate content to stdin.');
            }
            logDebug('Closing consolidate process stdin.');
            process.stdin!.end(); // Close stdin AFTER writing
        });

    } catch (error: any) {
        status.dispose();
        vscode.window.showErrorMessage(`Error running lectic --consolidate: ${error.message}.`);
        logDebug(`Error caught during lectic --consolidate setup/spawn:`, error);
    }
}


/**
 * Command: lectic.explainSelection
 * Calls transformSelection with a specific directive.
 */
export async function explainSelection() {
     logDebug("Command 'lectic.explainSelection' triggered.");
    await transformSelection("Add more explanation and detail.");
}

/**
 * Generic function to transform a selection using lectic.
 * (No streaming needed here usually)
 * @param directive A natural language instruction for the transformation.
 */
async function transformSelection(directive: string) {
    logDebug(`TransformSelection called with directive: "${directive}"`);
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.selection || editor.selection.isEmpty) {
        logDebug('No active editor or selection is empty.');
        vscode.window.showInformationMessage('No text selected.');
        return;
    }
    if (!(await checkLecticExists())) {
         logDebug('checkLecticExists failed, aborting transform.');
        return; // Stop if lectic is not found
    }

    const document = editor.document;
    const selection = editor.selection;
    const selectedText = document.getText(selection);
    const fullText = document.getText(); // Get full context
    const lecticPath = getLecticExecutablePath();

    // --- Construct Query ---
    const query = `${fullText}\n\n` +
                  `Please rewrite this earlier selection from the discussion. ${directive} ` +
                  `Your output will be used to replace the text, so don't comment on what you're doing, just provide replacement text.\n\n` +
                  `<selection>${selectedText}</selection>`;
    logDebug(`Transform query length: ${query.length}`);


    const status = vscode.window.setStatusBarMessage(`$(sync~spin) Transforming selection...`);
    const commandArgs = ['-S'];
    const cwd = getWorkingDirectory(document);
    const spawnOptions: cp.SpawnOptions = { cwd: cwd, env: process.env };

    logDebug(`Spawning lectic process for transform...`);
    logDebug(`  Executable: ${lecticPath}`);
    logDebug(`  Arguments: ${JSON.stringify(commandArgs)}`);
    logDebug(`  Options: ${JSON.stringify({ cwd: spawnOptions.cwd, env: 'process.env' })}`);

    try {
        const lecticProcess = cp.spawn(lecticPath, commandArgs, spawnOptions);

        if (!lecticProcess.stdin || !lecticProcess.stdout || !lecticProcess.stderr) {
            logDebug('Critical Error: Standard IO streams not available on transform process.');
            status.dispose();
            vscode.window.showErrorMessage('Failed to get standard IO streams for lectic transform.');
            lecticProcess.removeAllListeners();
            return;
        }

        let outputData = '';
        let errorData = '';

        lecticProcess.stdout.on('data', (dataChunk: Buffer) => {
            const chunk = dataChunk.toString();
            logDebug(`transform stdout chunk (${chunk.length} chars)`);
            outputData += chunk;
        });
        lecticProcess.stderr.on('data', (dataChunk: Buffer) => {
            const chunk = dataChunk.toString();
            logDebug(`transform stderr chunk (${chunk.length} chars)`);
            errorData += chunk;
            console.error(`[LecticStderr-Transform] ${chunk}`);
        });

         lecticProcess.on('error', (err) => {
            status.dispose();
            vscode.window.showErrorMessage(`Failed to start lectic transform: ${err.message}.`);
            logDebug(`'error' event on transform process:`, err);
        });

        lecticProcess.on('close', async (code, signal) => {
            status.dispose();
            logDebug(`'close' event on transform process. Code: ${code}, Signal: ${signal}`);
            logDebug(`  Final accumulated stdout length: ${outputData.length}`);
            logDebug(`  Final accumulated stderr length: ${errorData.length}`);

             if (signal) {
                 vscode.window.showErrorMessage(`Lectic transform process terminated by signal: ${signal}`);
                 logDebug(`Transform process terminated by signal: ${signal}`);
                 return;
             }
            if (code !== 0) {
                const displayError = errorData || 'Unknown error (no stderr output)';
                vscode.window.showErrorMessage(`Lectic transform failed (code ${code}): ${displayError}.`);
                 logDebug(`Transform process exited with error code ${code}. stderr content: "${errorData}"`);
                return;
            }
            if (!outputData) {
                vscode.window.showInformationMessage('Lectic returned no transformation.');
                logDebug('Transform process completed successfully but returned no output.');
                return;
            }

            logDebug('Applying transformation edit.');
            const success = await editor.edit(editBuilder => {
                editBuilder.replace(selection, outputData);
            }, { undoStopBefore: true, undoStopAfter: true }); // Single undo step for transform

            logDebug(`Transformation edit applied: ${success}`);

            if (!success) {
                vscode.window.showErrorMessage('Failed to apply transformation edit.');
                logDebug('Transformation edit application failed.');
            } else {
                 logDebug('Updating decorations after transform.');
                 updateDecorations(editor);
            }
        });

        // --- Write Query to Stdin (Checked for null above, use '!') ---
        logDebug('Writing query to transform process stdin...');
        lecticProcess.stdin!.write(query, (err) => {
             if (err) {
                logDebug(`Error writing transform query to stdin:`, err);
             } else {
                logDebug('Finished writing transform query to stdin.');
            }
            logDebug('Closing transform process stdin.');
            lecticProcess.stdin!.end(); // Close stdin to signal end of input
        });


    } catch (error: any) {
        status.dispose();
        vscode.window.showErrorMessage(`Error transforming selection: ${error.message}.`);
        logDebug(`Error caught during transform setup/spawn:`, error);
    }
}

// --- End file: /home/graham/Projects/lectic/extra/lectic.vscode/src/commands.ts ---
