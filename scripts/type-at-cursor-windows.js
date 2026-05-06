#!/usr/bin/env node

import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";

const DEFAULT_DELAY_MS = 3000;
const DEFAULT_INTERVAL_MS = 80;
const DEFAULT_INPUT_FILE = path.resolve(process.cwd(), "input.txt");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
	console.log(`Type the contents of a text file into the currently focused Windows input after a short delay.

Usage:
  node ./scripts/type-at-cursor-windows.js
  node ./scripts/type-at-cursor-windows.js --file C:\\path\\to\\input.txt --delay 3000 --interval 80

Options:
  --file       Text file to read from (default: ./input.txt)
  --delay      Initial wait in ms before typing starts (default: 3000)
  --interval   Delay in ms between each key (default: 80)
  --help       Show this help

Notes:
  - Before the delay ends, place the caret in the target input box.
  - This uses Windows SendKeys, so the target window must stay focused.
`);
}

function parseArgs(argv) {
	const args = {
		file: DEFAULT_INPUT_FILE,
		delay: DEFAULT_DELAY_MS,
		interval: DEFAULT_INTERVAL_MS,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}

		if (arg === "--file") {
			args.file = path.resolve(argv[i + 1] || "");
			i += 1;
			continue;
		}

		if (arg === "--delay") {
			args.delay = Number.parseInt(argv[i + 1] || `${DEFAULT_DELAY_MS}`, 10);
			i += 1;
			continue;
		}

		if (arg === "--interval") {
			args.interval = Number.parseInt(argv[i + 1] || `${DEFAULT_INTERVAL_MS}`, 10);
			i += 1;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!fs.existsSync(args.file)) {
		throw new Error(`Input file not found: ${args.file}`);
	}

	if (Number.isNaN(args.delay) || args.delay < 0) {
		throw new Error("--delay must be a number >= 0");
	}

	if (Number.isNaN(args.interval) || args.interval < 0) {
		throw new Error("--interval must be a number >= 0");
	}

	return args;
}

function readInputText(filename) {
	return fs.readFileSync(filename, "utf8");
}

function toSendKeysToken(char) {
	if (char === "\n") {
		return "{ENTER}";
	}

	if (char === "\t") {
		return "{TAB}";
	}

	if (char === "\b") {
		return "{BACKSPACE}";
	}

	if (char === " ") {
		return " ";
	}

	const specialChars = new Set(["+", "^", "%", "~", "(", ")", "[", "]"]);
	if (specialChars.has(char)) {
		return `{${char}}`;
	}

	if (char === "{") {
		return "{{}";
	}

	if (char === "}") {
		return "{}}";
	}

	return char;
}

function toPowerShellSingleQuoted(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

function buildPowerShellScript(tokens, interval) {
	const tokenList = tokens.map(toPowerShellSingleQuoted).join(", ");

	return `
$wshell = New-Object -ComObject WScript.Shell
$tokens = @(${tokenList})
foreach ($token in $tokens) {
	$wshell.SendKeys($token)
	Start-Sleep -Milliseconds ${interval}
}
`.trim();
}

function runPowerShell(script) {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr || error.message));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

async function main() {
	try {
		const args = parseArgs(process.argv.slice(2));
		const text = readInputText(args.file);
		const tokens = Array.from(text).map(toSendKeysToken);

		console.log(`Typing ${args.file} in ${args.delay}ms. Put the cursor in the target field now.`);
		await sleep(args.delay);

		const script = buildPowerShellScript(tokens, args.interval);
		await runPowerShell(script);
	} catch (error) {
		console.error(error.message);
		console.error("");
		printHelp();
		process.exit(1);
	}
}

await main();
