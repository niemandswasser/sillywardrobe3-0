// Real Chromium DOM/layout checks; isolated profile, no API or personal data.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);
let browser;
for (const path of [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean)) {
    try { await access(path); browser = path; break; } catch { /* next */ }
}
if (!browser) throw new Error('Set CHROME_PATH to an installed Chromium browser.');
for (const size of ['1280,900', '390,844', '390,650', '844,430']) {
    const profile = await mkdtemp(join(tmpdir(), 'iig-wardrobe-test-'));
    const { stdout } = await run(browser, ['--headless', '--disable-gpu', '--no-first-run',
        '--disable-extensions', '--allow-file-access-from-files', `--user-data-dir=${profile}`,
        `--window-size=${size}`, '--virtual-time-budget=1000', '--dump-dom',
        new URL('wardrobe-bulk.html', import.meta.url).href], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const result = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    if (!result?.startsWith('PASS:')) throw new Error(`${size}: ${result || 'missing browser result'}`);
    console.log(`${size}: ${result}`);
}
