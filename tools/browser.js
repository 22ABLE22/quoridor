// Shared, portable Playwright loading for the optional browser QA suites.
// The game itself does not use this module or require npm install.
'use strict';
const fs = require('fs');

function loadChromium() {
    const candidates = [process.env.PW_CORE, 'playwright', 'playwright-core'].filter(Boolean);
    const errors = [];
    for (const id of candidates) {
        try {
            const chromium = require(id).chromium;
            if (chromium) return chromium;
        } catch (error) {
            errors.push(id + ': ' + error.message);
        }
    }
    throw new Error([
        'Playwright is required for the browser QA scripts.',
        'Run "npm ci" and "npx playwright install chromium", or set PW_CORE to a Playwright module path.',
        ...errors
    ].join('\n'));
}

const chromium = loadChromium();

async function launchChromium() {
    const executablePath = process.env.PW_BROWSER || process.env.E2E_BROWSER;
    if (executablePath && !fs.existsSync(executablePath)) {
        throw new Error('Browser executable does not exist: ' + executablePath);
    }
    const options = { headless: true };
    if (executablePath) options.executablePath = executablePath;
    return chromium.launch(options);
}

module.exports = { launchChromium };
