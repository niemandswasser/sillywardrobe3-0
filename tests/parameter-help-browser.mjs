// Use an installed Chromium browser; no network, dependencies, or paid API calls.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);
const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let browser;
for (const path of candidates) {
    try { await access(path); browser = path; break; } catch { /* next candidate */ }
}
if (!browser) throw new Error('Set CHROME_PATH to an installed Chromium browser.');
const ui = await readFile(new URL('../src/ui/apiSection.js', import.meta.url), 'utf8');
const translations = JSON.parse(await readFile(new URL('../i18n/ru-ru.json', import.meta.url), 'utf8'));
const hints = [...ui.matchAll(/renderParameterHelp\(t`([^`]+)`\)/g)].map(match => match[1]);
if (hints.length !== 19 || hints.some(text => !translations[text])) throw new Error('Missing NovelAI hint or Russian translation');
for (const size of ['1280,900', '390,844']) {
    const profile = await mkdtemp(join(tmpdir(), 'iig-hint-test-'));
    const { stdout } = await run(browser, ['--headless', '--disable-gpu', '--no-first-run',
        '--disable-extensions', '--allow-file-access-from-files', `--user-data-dir=${profile}`,
        `--window-size=${size}`, '--virtual-time-budget=1000', '--dump-dom',
        new URL('parameter-help.html', import.meta.url).href], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const result = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    if (!result?.startsWith('PASS:')) throw new Error(`${size}: ${result || 'browser returned no test result'}`);
    console.log(`${size}: ${result}`);
}
console.log('PASS: all 19 NovelAI hints have Russian translations');
