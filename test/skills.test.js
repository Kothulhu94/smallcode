'use strict';

// SmallCode — SkillManager tests
// Pins issues #52 (CRLF frontmatter parsing on Windows) and
// #53 (.agents/skills + .claude/skills auto-detection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SkillManager } = require('../src/plugins/skills');

function freshProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-skills-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('issue #52: skill files with CRLF frontmatter parse correctly', () => {
  const dir = freshProject();
  const skill = path.join(dir, '.smallcode', 'skills', 'crlf-skill.md');
  // Authored on Windows — frontmatter delimiters separated by \r\n
  const body = '---\r\nname: crlf-skill\r\ntrigger: manual\r\n---\r\nHello CRLF.\r\n';
  write(skill, body);

  const sm = new SkillManager(dir);
  const got = sm.get('crlf-skill');
  assert.ok(got, 'skill should load despite CRLF line endings');
  assert.equal(got.trigger, 'manual');
  assert.match(got.content, /Hello CRLF\./);
});

test('issue #52: LF-only skill files still parse', () => {
  const dir = freshProject();
  const skill = path.join(dir, '.smallcode', 'skills', 'lf-skill.md');
  write(skill, '---\nname: lf-skill\ntrigger: auto\n---\nLF only body.\n');

  const sm = new SkillManager(dir);
  const got = sm.get('lf-skill');
  assert.ok(got);
  assert.equal(got.trigger, 'auto');
  assert.match(got.content, /LF only body\./);
});

test('issue #53: .agents/skills/<name>/SKILL.md is auto-detected', () => {
  const dir = freshProject();
  const skillFile = path.join(dir, '.agents', 'skills', 'my-procedure', 'SKILL.md');
  write(skillFile, '# my procedure\n\nDo the thing.');

  const sm = new SkillManager(dir);
  const got = sm.get('my-procedure');
  assert.ok(got, '.agents/skills nested skill should auto-load');
  assert.equal(got.origin, 'nested');
  assert.match(got.content, /Do the thing\./);
});

test('issue #53: .claude/skills/<name>/SKILL.md is auto-detected', () => {
  const dir = freshProject();
  const skillFile = path.join(dir, '.claude', 'skills', 'review-pr', 'SKILL.md');
  write(skillFile, '# pr review\n\nAlways check tests first.');

  const sm = new SkillManager(dir);
  const got = sm.get('review-pr');
  assert.ok(got, '.claude/skills nested skill should auto-load');
  assert.match(got.content, /Always check tests first/);
});

test('issue #53: nested layout with explicit YAML frontmatter wins over folder name', () => {
  const dir = freshProject();
  const skillFile = path.join(dir, '.agents', 'skills', 'folder-name', 'SKILL.md');
  write(skillFile, '---\nname: real-name\ntrigger: match\nkeywords: [foo, bar]\n---\nbody');

  const sm = new SkillManager(dir);
  const got = sm.get('real-name');
  assert.ok(got, 'should resolve by frontmatter name');
  assert.equal(got.trigger, 'match');
  assert.deepEqual(got.keywords, ['foo', 'bar']);
});

test('list() reports nested skills with origin marker', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'flat.md'),
        '---\nname: flat\ntrigger: manual\n---\nflat body');
  write(path.join(dir, '.agents', 'skills', 'nested-one', 'SKILL.md'),
        '# nested\nbody');

  const sm = new SkillManager(dir);
  const list = sm.list();
  const flat = list.find(s => s.name === 'flat');
  const nested = list.find(s => s.name === 'nested-one');
  assert.ok(flat && nested);
  assert.equal(flat.origin, 'flat');
  assert.equal(nested.origin, 'nested');
});

test('add() persists a new skill and round-trips through .smallcode/skills', () => {
  const dir = freshProject();
  const sm = new SkillManager(dir);
  sm.add('greeting', 'always greet warmly', { trigger: 'auto' });

  const sm2 = new SkillManager(dir);
  const got = sm2.get('greeting');
  assert.ok(got);
  assert.equal(got.trigger, 'auto');
  assert.match(got.content, /greet warmly/);
});

test('getAutoSkills selects auto + matching keyword skills', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'always.md'),
        '---\nname: always\ntrigger: auto\n---\nalways on');
  write(path.join(dir, '.smallcode', 'skills', 'review.md'),
        '---\nname: review\ntrigger: match\nkeywords: [review, pr]\n---\nreview body');

  const sm = new SkillManager(dir);
  const auto = sm.getAutoSkills('please review my PR');
  const names = auto.map(s => s.name).sort();
  assert.deepEqual(names, ['always', 'review']);
});
