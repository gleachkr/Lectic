import { homedir, tmpdir } from 'os';
import { join } from 'path';

const appName = 'lectic';
const home = homedir();

type DirType = 'config' | 'data' | 'cache' | 'state';

function getBaseDir(type: DirType): string {
    switch (process.platform) {
        case 'win32': {
            const local = process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local');
const roaming = process.env['APPDATA'] || join(home, 'AppData', 'Roaming');
            switch (type) {
                case 'config': return roaming;
                case 'data':   return roaming;
                case 'cache':  return local;
                case 'state':  return local;
            }
        }
        case 'darwin': {
            const library = join(home, 'Library');
            switch (type) {
                case 'config': return join(library, 'Preferences');
                case 'data':   return join(library, 'Application Support');
                case 'cache':  return join(library, 'Caches');
                case 'state':  return join(library, 'Application Support');
            }
        }
        default: { // linux and other POSIX
            const linuxDefaults = {
                config: { env: 'XDG_CONFIG_HOME', path: '.config' },
                data:   { env: 'XDG_DATA_HOME',   path: '.local/share' },
                cache:  { env: 'XDG_CACHE_HOME',  path: '.cache' },
                state:  { env: 'XDG_STATE_HOME',  path: '.local/state' }
            };
            const { env, path } = linuxDefaults[type];
            return process.env[env] || join(home, path);
        }
    }
}

// Lectic-specific paths, built from the base directories
export const lecticConfigDir = () => join(getBaseDir('config'), appName);
export const lecticDataDir = () => join(getBaseDir('data'), appName);
export const lecticCacheDir = () => join(getBaseDir('cache'), appName);
export const lecticStateDir = () => join(getBaseDir('state'), appName);
export const lecticTempDir = () => join(tmpdir(), appName);
