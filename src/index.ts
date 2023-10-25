import { createTemporaryFileSystem, deleteTemporaryDirectory } from './helpers/createReactFileSystem';
import { installReactDependencies, runReactAppInDev, clearPortForReactAppLaunch } from './helpers/buildReactApp';
import puppeteer, { Browser, Page } from 'puppeteer';
import { saveErrorInfo } from "./lib/firestore";

const fs = require('fs-extra');
const path = require('path');


const PACKAGE_JSON_TEMPLATE = `
{
    "dependencies": {
        "react": "^18.0.0",
            "react-dom": "^18.0.0",
                "react-scripts": "^4.0.0"
},
"scripts": {
    "start": "BROWSER=none react-scripts --openssl-legacy-provider start"
},
"main": "./src/index.js",
    "browserslist": {
    "production": [
        ">0.2%",
        "not dead",
        "not op_mini all"
    ],
        "development": [
            "last 1 chrome version",
            "last 1 firefox version",
            "last 1 safari version"
        ]
}
}`;

async function captureReactAppOutput(logErrorsOnly = true): Promise<{ errors: string[], screenshot: string | undefined }> {
    const errorSet = new Set<string>();
    const browser: Browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.CHROME_BIN,
    });
    const page: Page = await browser.newPage();

    !logErrorsOnly && page.on('console', (msg) => {
        console.log(`React App Console [${msg.type()}]:`, msg.text());
        if (msg.text().includes('error')) {
            console.log(`Adding to errorSet: ${msg.text()}`);
            errorSet.add(msg.text());
        }
    });

    // Capture uncaught exceptions from the React app
    page.on('pageerror', (err) => {
        // console.log('React App Error:', err.message);
        errorSet.add(err.message);
    });

    await page.goto('http://localhost:3000');
    // Wait for 2 seconds for everything to load
    // TODO test to see if we need to timeout at all in order to capture errors.
    // TODO look for page onload event.
    await new Promise(r => setTimeout(r, 2000));

    // Capture a screenshot
    const screenshot = await page.screenshot({ encoding: 'base64' });

    await browser.close();

    // Remove the child_processes-specific error message from the set
    errorSet.delete("process is not defined");

    return { errors: [...errorSet], screenshot };
}

function getCleanedHeliconeData(heliconeData: Record<string, any>): Record<string, string> | null {
    // LLM response code
    const LLMresponse = heliconeData.response;

    // Extract the content between the three backticks
    const regex = /```([\s\S]*?)```/g;
    const match = regex.exec(LLMresponse);

    if (match && match[1]) {
        let extractedContent = match[1].trim();
        // Convert escaped newlines to actual newlines
        extractedContent = extractedContent.replace(/\\n/g, '\n');
        // Remove the Unicode escape sequences
        extractedContent = extractedContent.replace(/\\\\/g, '\\');
        extractedContent = extractedContent.replace(/\\\"/g, '\"');
        // Replace all Unicode escape sequences
        extractedContent = extractedContent.replace(/\\u([\dA-Fa-f]{4})/g, (_, g) => String.fromCharCode(parseInt(g, 16)));

        // Split the content by newline and remove the first line as it's not necessary
        const lines = extractedContent.split('\n').slice(1);
        extractedContent = lines.join('\n');

        // Extract imported libraries
        const importLines = lines.filter(line => line.startsWith('import'));
        const libraries = importLines.map(line => {
            const match = line.match(/'([^']+)'/);
            return match ? match[1] : null;
        }).filter(lib => lib !== 'react' && lib !== './tailwind-config.js');

        // Modify PACKAGE_JSON_TEMPLATE to include the libraries
        const dependenciesIndex = PACKAGE_JSON_TEMPLATE.indexOf('"dependencies": {') + 17;
        const dependenciesToAdd = libraries.map(lib => `"${lib}": "*"`).join(',\n');
        const modifiedPackageJson = [
            PACKAGE_JSON_TEMPLATE.slice(0, dependenciesIndex),
            dependenciesToAdd,
            libraries.length > 0 ? ',' : '', // Add comma after the last new library
            PACKAGE_JSON_TEMPLATE.slice(dependenciesIndex)
        ].join('');

        return {
            prompt: heliconeData.prompt,
            packageDotJSON: modifiedPackageJson,
            appDotJS: extractedContent,
            projectID: heliconeData.id,
        }
    } else {
        return null;
    }
}


(async () => {
    const filePath = path.join(__dirname, '..', 'helicone_gitwit_react_results.json');
    const rawData = fs.readFileSync(filePath, 'utf-8');
    const jsonData = JSON.parse(rawData);

    // TODO remove before deploy to production.
    // let count = 0;

    // Create Temporary Folder/File Structure
    console.log("Creating template app...");
    const { reactAppDirObj: templateAppDirObj, reactAppDir: templateAppDir } = createTemporaryFileSystem("/* */", PACKAGE_JSON_TEMPLATE);
    console.log("Installing dependencies for template app...");
    installReactDependencies(templateAppDir);

    for (const entry of jsonData) {
        // Grab necessary data from helicone
        const cleanedHeliconeData = getCleanedHeliconeData(entry);
        if (!cleanedHeliconeData) continue;

        // Create Temporary Folder/File Structure
        const { reactAppDirObj, reactAppDir } = createTemporaryFileSystem(cleanedHeliconeData.appDotJS, cleanedHeliconeData.packageDotJSON);
        // Copy the node_modules from the template app to the new app.
        fs.copySync(templateAppDir + "/node_modules", reactAppDir  + "/node_modules");

        // Perform child_process in-sync opperations.
        try {
            clearPortForReactAppLaunch(3000);
            installReactDependencies(reactAppDir);
        } catch (error: any) {
            deleteTemporaryDirectory(reactAppDirObj);
            console.error(error);
            continue;
        }

        // Run async child_process with react dev server.
        const { childProcess, started, exited } = runReactAppInDev(reactAppDir);
        try {
            await started;
            console.log("Child Process successfully started React App in Dev.");
        } catch (error: any) {
            deleteTemporaryDirectory(reactAppDirObj);
            console.error(`ERROR: when trying to run the React app: ${error}`);
            continue;
        }

        // Create headless browser and capture errors, if any.
        console.log("Back in the main thread. Should call captureReactAppOutput to start headless browser...");
        const { errors: reactAppErrors, screenshot: reactAppScreenshot } = await captureReactAppOutput(false);

        // Only save this React App data if it has an error.
        try {
            await saveErrorInfo({
                prompt: cleanedHeliconeData.prompt,
                errors: reactAppErrors,
                appDotJs: cleanedHeliconeData.appDotJS,
                packageDotJson: cleanedHeliconeData.packageDotJSON,
                projectID: cleanedHeliconeData.projectID,
                screenshot: reactAppScreenshot,
            });
        } catch (error: any) {
            console.error(`Unable to save react app errors to DB: ${error}`)
        }

        if (childProcess.kill('SIGTERM')) {
            console.log("Signal sent to child process to terminate.");

            const timeoutDuration = 3000;
            const timeout = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Graceful shutdown timeout')), timeoutDuration);
            });

            try {
                // await exited or timeout, whichever finishes first.
                await Promise.race([exited, timeout]);
                console.log("Child process has been killed. Main process can continue execution...");
            } catch (error) {
                console.warn('Child process did not respond to SIGTERM or graceful shutdown timeout. Sending SIGKILL to force exit.');
                childProcess.kill('SIGKILL');
            }
        }


        // TODO test to see if I still need this.
        await new Promise(r => setTimeout(r, 1000));

        // Delete the Temporary Folder/File Structure.
        deleteTemporaryDirectory(reactAppDirObj);

        // TODO remove before deploy to production.
        // if (count === 1) {
        //     process.exit(0);
        // } else {
        //     count++;
        // }
    }

    // Delete the Temporary Folder/File Structure.
    deleteTemporaryDirectory(templateAppDirObj);

    // Exit node process with code success to avoid CRON automatic retrial
    process.exit(0);
})();