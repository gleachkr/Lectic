import { loadFrom as loadable } from './loader';
import { expect, it, describe } from "bun:test";
import { writeFileSync, unlinkSync } from 'fs';

describe('loader', () => {
    const testFilePath = './test_loadable_file.txt';
    const testFileContent = 'This is a test file.';

    // Setup: create a test file before running tests
    const setup = () => {
        writeFileSync(testFilePath, testFileContent);
    };

    // Teardown: remove the test file after tests are done
    const teardown = () => {
        try {
            unlinkSync(testFilePath);
        } catch (error) {
            // Ignore errors if the file doesn't exist
        }
    };

    describe('loadable', () => {
        it('should return the string if it is not a file or exec loader', async () => {
            const content = 'This is a simple string.';
            const result = await loadable(content);
            expect(result).toBe(content);
        });

        it('should load content from a file if the string starts with "file:"', async () => {
            setup();
            const filePath = `file:${testFilePath}`;
            const result = await loadable(filePath);
            expect(result).toBe(testFileContent);
            teardown();
        });

        it('should load content from a command if the string starts with "exec:"', async () => {
            const command = 'exec:echo "This is a command."';
            const result = await loadable(command);
            // Bun's echo includes a trailing newline
            expect(result).toBe('This is a command.\n');
        });

        it('should throw an error for an empty file path', async () => {
            const filePath = 'file:';
            await expect(loadable(filePath)).rejects.toThrow("File path cannot be empty.");
        });

        it('should throw an error for an empty exec command', async () => {
            const command = 'exec:';
            await expect(loadable(command)).rejects.toThrow("Exec command cannot be empty.");
        });
    });
});
