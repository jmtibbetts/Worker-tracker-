'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignatures, detectForeground, detectProcesses, parseCustomTools } = require('../src/shared/aiDetector');

const sigs = buildSignatures('Acme Assistant | assistant.acme.test, Acme Assistant');

test('detects an AI desktop app by process name', () => {
  assert.equal(detectForeground({ app: 'ChatGPT', title: '' }, sigs).name, 'ChatGPT');
  assert.equal(detectForeground({ app: 'Cursor.exe', title: 'main.js' }, sigs).name, 'Cursor');
  assert.equal(detectForeground({ app: 'Some Editor', process: 'windsurf', title: '' }, sigs).name, 'Windsurf');
});

test('detects an AI web page by browser window title', () => {
  const hit = detectForeground({ app: 'Google Chrome', title: 'Fix my SQL query - ChatGPT - Google Chrome' }, sigs);
  assert.deepEqual(hit, { name: 'ChatGPT', kind: 'assistant', via: 'title' });
});

test('detects an AI web page by URL, including sub-domains and paths', () => {
  assert.equal(detectForeground({ app: 'Safari', title: 'Untitled', url: 'https://www.perplexity.ai/search?q=x' }, sigs).name, 'Perplexity');
  assert.equal(detectForeground({ app: 'Safari', title: '', url: 'https://github.com/copilot/c/123' }, sigs).name, 'GitHub Copilot');
  assert.equal(detectForeground({ app: 'Safari', title: 'repo', url: 'https://github.com/someone/repo' }, sigs), null);
});

test('GitHub Copilot is not reported as Microsoft Copilot', () => {
  assert.equal(detectForeground({ app: 'Code', title: 'GitHub Copilot Chat - project' }, sigs).name, 'GitHub Copilot');
  assert.equal(detectForeground({ app: 'msedge', title: 'Microsoft Copilot - Edge' }, sigs).name, 'Microsoft Copilot');
});

test('does not flag ordinary work', () => {
  assert.equal(detectForeground({ app: 'Microsoft Excel', title: 'Budget 2026.xlsx' }, sigs), null);
  assert.equal(detectForeground({ app: 'Google Chrome', title: 'Edgar Allan Poe - Wikipedia' }, sigs), null);
  assert.equal(detectForeground({ app: 'Terminal', title: 'mouse cursor settings' }, sigs), null);
  assert.equal(detectForeground(null, sigs), null);
});

test('custom tools are matched by title and domain', () => {
  assert.equal(detectForeground({ app: 'Firefox', title: 'Acme Assistant – chat' }, sigs).name, 'Acme Assistant');
  assert.equal(detectForeground({ app: 'Safari', title: '', url: 'https://assistant.acme.test/c/1' }, sigs).name, 'Acme Assistant');
});

test('parseCustomTools ignores blanks and comments', () => {
  const tools = parseCustomTools('\n# comment\nFoo\nBar | bar.app, Bar Bot\n');
  assert.deepEqual(tools.map((t) => t.name), ['Foo', 'Bar']);
});

test('detectProcesses finds background AI apps', () => {
  const found = detectProcesses(['explorer.exe', 'ollama.exe', 'LM Studio', 'chrome.exe'], sigs);
  assert.deepEqual(found.sort(), ['LM Studio', 'Ollama']);
});
