import { loadFrom as loadable } from './loader';
import { expect, it, describe } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';

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
        } catch (_error) {
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
            expect(loadable(filePath)).rejects.toThrow("File path cannot be empty.");
        });

        it('should throw an error for an empty exec command', async () => {
            const command = 'exec:';
            expect(loadable(command)).rejects.toThrow("Exec command cannot be empty.");
        });

        describe('variable expansion', () => {
            it('should expand environment variables in a file path', async () => {
                const dirName = 'temp_test_dir_for_loader';
                process.env['TEST_DIR'] = dirName;
                const testContent = 'File content in a temp dir';
                mkdirSync(dirName, { recursive: true });
                const filePath = join(dirName, 'test.txt')
                writeFileSync(filePath, testContent);

                const result = await loadable('file:$TEST_DIR/test.txt');
                expect(result).toBe(testContent);

                unlinkSync(filePath);
                rmdirSync(dirName);
                delete process.env['TEST_DIR'];
            });

            it('should expand environment variables in an exec command', async () => {
                process.env['TEST_ECHO_MSG'] = 'An echo message';
                const result = await loadable('exec:echo $TEST_ECHO_MSG');
                expect(result).toBe('An echo message\n');
                delete process.env['TEST_ECHO_MSG'];
            });
        });
    });
});
