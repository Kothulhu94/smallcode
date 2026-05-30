'use strict';

const fs = require('fs');
const path = require('path');

const SUITES = {
  smoke: [
    {
      id: 'create-hello',
      lang: 'python',
      prompt: 'Create hello.py with a function greet(name) that returns "Hello, {name}!" using an f-string.',
      verify: ({ dir }) => fs.existsSync(path.join(dir, 'hello.py')),
    },
    {
      id: 'fix-typo',
      lang: 'python',
      seed: { 'add.py': 'def add(a, b):\n    return a - b\n' },
      prompt: 'There is a bug in add.py — the function uses subtraction instead of addition. Fix it.',
      verify: ({ dir }) => {
        const content = fs.readFileSync(path.join(dir, 'add.py'), 'utf-8');
        return content.includes('a + b') && !content.includes('a - b');
      },
    },
    {
      id: 'create-readme',
      lang: 'markdown',
      prompt: 'Create a README.md describing a project called "TodoApp" with sections: ## Features, ## Install, ## Usage.',
      verify: ({ dir }) => {
        const p = path.join(dir, 'README.md');
        if (!fs.existsSync(p)) return false;
        const c = fs.readFileSync(p, 'utf-8');
        return c.includes('## Features') && c.includes('## Install') && c.includes('## Usage');
      },
    },
    {
      id: 'multi-file',
      lang: 'python',
      prompt: 'Create two files: utils.py with a function double(x) returning x*2, and main.py that imports double from utils and prints double(5).',
      verify: ({ dir }) => {
        const utils = path.join(dir, 'utils.py');
        const main = path.join(dir, 'main.py');
        if (!fs.existsSync(utils) || !fs.existsSync(main)) return false;
        return fs.readFileSync(utils, 'utf-8').includes('def double') &&
               fs.readFileSync(main, 'utf-8').includes('from utils');
      },
    },
    {
      id: 'shell-command',
      lang: 'shell',
      prompt: 'Use bash to create a file called "marker.txt" with the text "found".',
      verify: ({ dir }) => {
        const p = path.join(dir, 'marker.txt');
        return fs.existsSync(p) && fs.readFileSync(p, 'utf-8').includes('found');
      },
    },
  ],

  // Polyglot-mini: 4 tasks per language, intentionally short and self-contained.
  // Each task has a deterministic verify step that does NOT require running tests
  // (to keep the harness fast and not dependent on language toolchains).
  'polyglot-mini': [
    // Python (4)
    {
      id: 'py-fibonacci',
      lang: 'python',
      prompt: 'Create fib.py with a function fib(n) returning the nth Fibonacci number (fib(0)=0, fib(1)=1).',
      verify: ({ dir }) => {
        const p = path.join(dir, 'fib.py');
        if (!fs.existsSync(p)) return false;
        const c = fs.readFileSync(p, 'utf-8');
        return /def fib/.test(c);
      },
    },
    {
      id: 'py-class-account',
      lang: 'python',
      prompt: 'Create account.py with a class Account that has methods deposit(amount), withdraw(amount), and balance().',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'account.py'), 'utf-8');
        return /class Account/.test(c) && /def deposit/.test(c) && /def withdraw/.test(c) && /def balance/.test(c);
      },
    },
    {
      id: 'py-fix-list',
      lang: 'python',
      seed: { 'sum.py': 'def sum_list(items):\n    total = 0\n    for x in items:\n        total += 2 * x\n    return total\n' },
      prompt: 'Fix sum_list in sum.py — it should sum the items, not double them.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'sum.py'), 'utf-8');
        return c.includes('total += x') || c.includes('sum(items)') || c.includes('total = total + x');
      },
    },
    {
      id: 'py-add-test',
      lang: 'python',
      seed: { 'mul.py': 'def mul(a, b):\n    return a * b\n' },
      prompt: 'Add a test_mul.py file with three unittest test cases for the mul function in mul.py.',
      verify: ({ dir }) => {
        const p = path.join(dir, 'test_mul.py');
        if (!fs.existsSync(p)) return false;
        const c = fs.readFileSync(p, 'utf-8');
        return /unittest/.test(c) && (c.match(/def test/g) || []).length >= 3;
      },
    },

    // JavaScript (4)
    {
      id: 'js-double',
      lang: 'javascript',
      prompt: 'Create double.js exporting a function double(x) that returns x*2. Use module.exports.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'double.js'), 'utf-8');
        return /module\.exports/.test(c) && /double/.test(c);
      },
    },
    {
      id: 'js-arrow',
      lang: 'javascript',
      seed: { 'app.js': 'function add(a, b) {\n    return a + b;\n}\n\nmodule.exports = { add };\n' },
      prompt: 'Refactor add in app.js to use arrow function syntax, keeping the same module.exports.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
        return /=>\s*\{?\s*(?:return\s+)?a\s*\+\s*b/.test(c) || /=\s*\(?a,\s*b\)?\s*=>/.test(c);
      },
    },
    {
      id: 'js-package',
      lang: 'javascript',
      prompt: 'Create a package.json for a Node.js project named "calc" with version 1.0.0, main "index.js", and one dev dependency "jest" set to ^29.0.0.',
      verify: ({ dir }) => {
        const p = path.join(dir, 'package.json');
        if (!fs.existsSync(p)) return false;
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
          return j.name === 'calc' && j.devDependencies?.jest;
        } catch { return false; }
      },
    },
    {
      id: 'js-fix-async',
      lang: 'javascript',
      seed: { 'fetcher.js': 'function getData() {\n    fetch("/api").then(r => r.json());\n}\nmodule.exports = { getData };\n' },
      prompt: 'Make getData in fetcher.js an async function that returns the JSON.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'fetcher.js'), 'utf-8');
        return /async\s+function\s+getData/.test(c) && /await/.test(c) && /return/.test(c);
      },
    },

    // TypeScript (3)
    {
      id: 'ts-interface',
      lang: 'typescript',
      prompt: 'Create types.ts with an interface User { id: number; name: string; email: string; } and export it.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'types.ts'), 'utf-8');
        return /interface User/.test(c) && /id:\s*number/.test(c) && /name:\s*string/.test(c);
      },
    },
    {
      id: 'ts-generic',
      lang: 'typescript',
      prompt: 'Create stack.ts exporting a generic class Stack<T> with push(item: T), pop(): T | undefined, and size(): number.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'stack.ts'), 'utf-8');
        return /class Stack<T>/.test(c) && /push/.test(c) && /pop/.test(c) && /size/.test(c);
      },
    },
    {
      id: 'ts-tsconfig',
      lang: 'typescript',
      prompt: 'Create a tsconfig.json with strict mode enabled, target ES2022, module CommonJS, outDir dist.',
      verify: ({ dir }) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf-8'));
          return j.compilerOptions?.strict === true && /ES2022/i.test(j.compilerOptions?.target || '');
        } catch { return false; }
      },
    },

    // Bash/shell (3)
    {
      id: 'sh-list',
      lang: 'shell',
      seed: { 'a.txt': '', 'b.txt': '', 'c.txt': '' },
      prompt: 'Use bash to list all .txt files in the current directory and save the output to files.txt.',
      verify: ({ dir }) => {
        const p = path.join(dir, 'files.txt');
        if (!fs.existsSync(p)) return false;
        const c = fs.readFileSync(p, 'utf-8');
        return c.includes('a.txt') && c.includes('b.txt') && c.includes('c.txt');
      },
    },
    {
      id: 'sh-makefile',
      lang: 'shell',
      prompt: 'Create a Makefile with three targets: build (echoes "building"), test (echoes "testing"), and clean (echoes "cleaning"). Each must be tab-indented.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'Makefile'), 'utf-8');
        return /build:/.test(c) && /test:/.test(c) && /clean:/.test(c) && c.includes('\t');
      },
    },
    {
      id: 'sh-script',
      lang: 'shell',
      prompt: 'Create a run.sh shell script that prints "starting", then prints the current directory, then prints "done". First line should be #!/bin/sh shebang.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'run.sh'), 'utf-8');
        return /^#!/.test(c) && /starting/.test(c) && /done/.test(c) && /pwd|cd/.test(c);
      },
    },

    // Markdown/docs (2)
    {
      id: 'md-readme',
      lang: 'markdown',
      prompt: 'Create README.md with a project description, install instructions (npm install), usage example with a fenced code block, and a license section (MIT).',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
        return /npm install/.test(c) && /```/.test(c) && /MIT/i.test(c);
      },
    },
    {
      id: 'md-api',
      lang: 'markdown',
      prompt: 'Create API.md documenting two endpoints: GET /users (returns list of users) and POST /users (creates user). Include request/response examples for each.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'API.md'), 'utf-8');
        return /GET\s+\/users/.test(c) && /POST\s+\/users/.test(c);
      },
    },

    // JSON (2)
    {
      id: 'json-config',
      lang: 'json',
      prompt: 'Create config.json with: name "myapp", version "1.0.0", port 3000, features as an array containing "auth" and "logging".',
      verify: ({ dir }) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
          return j.name === 'myapp' && j.port === 3000 &&
                 Array.isArray(j.features) && j.features.includes('auth') && j.features.includes('logging');
        } catch { return false; }
      },
    },
    {
      id: 'json-fix',
      lang: 'json',
      seed: { 'broken.json': '{\n  "name": "test"\n  "version": "1.0",\n}' },
      prompt: 'Fix the JSON syntax errors in broken.json.',
      verify: ({ dir }) => {
        try { JSON.parse(fs.readFileSync(path.join(dir, 'broken.json'), 'utf-8')); return true; }
        catch { return false; }
      },
    },

    // Multi-file (2)
    {
      id: 'multi-imports',
      lang: 'python',
      prompt: 'Create math_utils/__init__.py and math_utils/operations.py. operations.py should have add(a,b) and multiply(a,b). __init__.py should re-export both.',
      verify: ({ dir }) => {
        const init = path.join(dir, 'math_utils', '__init__.py');
        const ops = path.join(dir, 'math_utils', 'operations.py');
        if (!fs.existsSync(init) || !fs.existsSync(ops)) return false;
        const opsC = fs.readFileSync(ops, 'utf-8');
        return /def add/.test(opsC) && /def multiply/.test(opsC);
      },
    },
  ],

  'tool-use': [
    {
      id: 'cd-and-create',
      lang: 'shell',
      prompt: 'Create a subdirectory called "src", cd into it, then create a file "main.py" with print("hello"). Use the bash tool. Verify by running ls/dir afterward.',
      verify: ({ dir }) => {
        const p = path.join(dir, 'src', 'main.py');
        return fs.existsSync(p) && fs.readFileSync(p, 'utf-8').includes('hello');
      },
    },
    {
      id: 'env-var',
      lang: 'shell',
      prompt: 'Use bash to set an env var FOO to "bar" in one tool call, then in a SECOND separate tool call write the value of FOO to env.txt.',
      verify: ({ dir }) => {
        const p = path.join(dir, 'env.txt');
        return fs.existsSync(p) && fs.readFileSync(p, 'utf-8').trim().includes('bar');
      },
    },
    {
      id: 'search-and-edit',
      lang: 'python',
      seed: {
        'a.py': 'def foo():\n    return "old"\n',
        'b.py': 'from a import foo\nprint(foo())\n',
      },
      prompt: 'Find every occurrence of the string "old" in the project and change it to "new".',
      verify: ({ dir }) => {
        const a = fs.readFileSync(path.join(dir, 'a.py'), 'utf-8');
        return a.includes('"new"') && !a.includes('"old"');
      },
    },
    {
      id: 'create-and-validate',
      lang: 'python',
      prompt: 'Create valid_json.json with {"name":"test","items":[1,2,3]}. Then verify it parses correctly using a bash command (python -c).',
      verify: ({ dir }) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, 'valid_json.json'), 'utf-8'));
          return j.name === 'test' && Array.isArray(j.items);
        } catch { return false; }
      },
    },
    {
      id: 'rename-symbol',
      lang: 'javascript',
      seed: {
        'lib.js': 'function getUserName(u) { return u.name; }\nmodule.exports = { getUserName };\n',
        'app.js': 'const { getUserName } = require("./lib");\nconsole.log(getUserName({name: "alice"}));\n',
      },
      prompt: 'Rename getUserName to fetchUsername everywhere in the project (both lib.js and app.js).',
      verify: ({ dir }) => {
        const lib = fs.readFileSync(path.join(dir, 'lib.js'), 'utf-8');
        const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
        return lib.includes('fetchUsername') && !lib.includes('getUserName') &&
               app.includes('fetchUsername') && !app.includes('getUserName');
      },
    },
    {
      id: 'add-feature-multi',
      lang: 'python',
      seed: {
        'calc.py': 'def add(a,b): return a+b\ndef sub(a,b): return a-b\n',
        'test_calc.py': 'from calc import add, sub\nassert add(2,3)==5\nassert sub(5,2)==3\n',
      },
      prompt: 'Add a multiply function to calc.py and a corresponding assertion to test_calc.py for multiply(3,4)==12.',
      verify: ({ dir }) => {
        const calc = fs.readFileSync(path.join(dir, 'calc.py'), 'utf-8');
        const test = fs.readFileSync(path.join(dir, 'test_calc.py'), 'utf-8');
        return /def multiply/.test(calc) && /multiply\(3\s*,\s*4\)/.test(test);
      },
    },
    {
      id: 'fix-from-error',
      lang: 'python',
      seed: { 'broken.py': 'def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))\n' },
      prompt: 'Run broken.py and fix whatever error occurs. Add proper handling for division by zero — return None on b==0.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'broken.py'), 'utf-8');
        return /b\s*==\s*0/.test(c) && /return\s+None/.test(c);
      },
    },
    {
      id: 'config-update',
      lang: 'json',
      seed: { 'package.json': '{"name":"app","version":"1.0.0","scripts":{"start":"node index.js"}}' },
      prompt: 'Add a "test" script to package.json that runs "jest", and add jest ^29.0.0 to devDependencies.',
      verify: ({ dir }) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
          return j.scripts?.test === 'jest' && !!j.devDependencies?.jest;
        } catch { return false; }
      },
    },
    {
      id: 'count-lines',
      lang: 'shell',
      seed: { 'data.txt': 'line1\nline2\nline3\nline4\nline5\n' },
      prompt: 'Count the lines in data.txt and write the count (just the number) to count.txt.',
      verify: ({ dir }) => {
        const c = fs.readFileSync(path.join(dir, 'count.txt'), 'utf-8').trim();
        return c === '5';
      },
    },
    {
      id: 'init-project',
      lang: 'multi',
      prompt: 'Initialize a small project with these files: README.md (just a title), src/index.js (console.log "ready"), .gitignore (ignore node_modules), package.json (name "demo" version 0.1.0).',
      verify: ({ dir }) => {
        const r = fs.existsSync(path.join(dir, 'README.md'));
        const i = fs.existsSync(path.join(dir, 'src', 'index.js'));
        const g = fs.existsSync(path.join(dir, '.gitignore'));
        const p = fs.existsSync(path.join(dir, 'package.json'));
        if (!r || !i || !g || !p) return false;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
          return pkg.name === 'demo';
        } catch { return false; }
      },
    },
  ],
};

module.exports = { SUITES };
