/**
 * Implements the FoldingRangeProvider interface for VS Code
 * to enable folding of <tool-call>...</tool-call> blocks
 * within 'lectic-markdown' documents.
 */
import * as vscode from 'vscode';

export class LecticFoldingProvider implements vscode.FoldingRangeProvider {

    /**
     * Provides folding ranges for the given document.
     * This method is called by VS Code to determine what parts of the code can be folded.
     * @param document The text document to provide folding ranges for.
     * @param context Context information about the folding operation.
     * @param token A cancellation token.
     * @returns An array of FoldingRange objects, or null/undefined if no ranges are found.
     */
    provideFoldingRanges(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FoldingRange[]> {

        const foldingRanges: vscode.FoldingRange[] = [];
        // Stack to keep track of the starting line numbers of open tags
        const stack: { tagName: string; line: number }[] = [];

        // Regular expressions to match potential opening and closing tags
        // Making these reasonably specific to avoid matching random XML/HTML.
        // Matches '<tool-call ...>' or '<tool_output ...>' etc. (adjust tag names if needed)
        // Allows attributes within the opening tag.
        const openTagRegex = /^\s*<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>\s*$/;
        // Matches '</tool-call>' or '</tool_output>' etc.
        const closeTagRegex = /^\s*<\/([a-zA-Z0-9_-]+)>\s*$/;

        // Iterate through each line of the document
        for (let i = 0; i < document.lineCount; i++) {
            // Check for cancellation request periodically for long documents
            if (token.isCancellationRequested) {
                return null;
            }

            const lineText = document.lineAt(i).text;

            const openMatch = lineText.match(openTagRegex);
            const closeMatch = lineText.match(closeTagRegex);

            if (openMatch) {
                // Found an opening tag, push its name and line number onto the stack
                stack.push({ tagName: openMatch[1], line: i });
            } else if (closeMatch && stack.length > 0) {
                // Found a closing tag, check if it matches the last opened tag
                const lastOpenTag = stack[stack.length - 1]; // Peek at the top
                if (closeMatch[1] === lastOpenTag.tagName) {
                    // It's a match! Pop the corresponding open tag from the stack.
                    const openTagInfo = stack.pop();
                    if (openTagInfo) { // Should always exist if stack wasn't empty
                        const startLine = openTagInfo.line;
                        const endLine = i;

                        // Only create a fold if the block spans multiple lines
                        if (endLine > startLine) {
                            // Create a FoldingRange object.
                            // The 'kind' can be 'Comment' or 'Region'. 'Region' is generic.
                            foldingRanges.push(new vscode.FoldingRange(
                                startLine,
                                // Adjust end line for better folding appearance.
                                // Often, folding the line *before* the closing tag looks better.
                                // However, folding the closing tag line itself matches nvim's default.
                                endLine,
                                vscode.FoldingRangeKind.Region // Use Region for non-comment folds
                            ));
                        }
                    }
                } else {
                     // Mismatched closing tag - could indicate error or nested tags of different types.
                     // For simple folding, we might ignore it or clear the stack depending on desired robustness.
                     // Current approach: Ignore mismatch, only fold matching pairs.
                }
            }
        }

        // Return the collected folding ranges
        return foldingRanges;
    }
}
// --- End file: lectic-vscode/src/foldingProvider.ts ---
