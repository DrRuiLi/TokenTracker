const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dist = require('../scripts/contributor-gift-distribution.cjs');

test('contributor distribution parseArgs handles options correctly', () => {
  assert.equal(dist.parseArgs(['--help']).help, true);
  assert.equal(dist.parseArgs([]).help, true);
  assert.throws(() => dist.parseArgs(['invalid-cmd']));

  const parsed = dist.parseArgs([
    'recommend-batch',
    '--repo', 'test/repo',
    '--days', '365',
    '--buffer', '20',
    '--environment', 'sandbox',
  ]);
  assert.equal(parsed.command, 'recommend-batch');
  assert.equal(parsed.repo, 'test/repo');
  assert.equal(parsed.days, 365);
  assert.equal(parsed.buffer, 20);
  assert.equal(parsed.environment, 'sandbox');
});

test('extractContributors accurately filters bots, owners and aggregates PRs', () => {
  const mockPrs = [
    {
      number: 101,
      title: 'feat: add a',
      author: { login: 'alice', name: 'Alice A', is_bot: false },
      mergedAt: '2026-09-01T00:00:00Z',
      url: 'https://github.com/test/repo/pull/101',
    },
    {
      number: 102,
      title: 'feat: add a 2',
      author: { login: 'alice', name: 'Alice A', is_bot: false },
      mergedAt: '2026-09-02T00:00:00Z',
      url: 'https://github.com/test/repo/pull/102',
    },
    {
      number: 103,
      title: 'feat: add b',
      author: { login: 'bob', name: 'Bob B', is_bot: false },
      mergedAt: '2026-09-03T00:00:00Z',
      url: 'https://github.com/test/repo/pull/103',
    },
    {
      number: 104,
      title: 'chore: bump deps',
      author: { login: 'dependabot[bot]', name: 'Dependabot', is_bot: true },
      mergedAt: '2026-09-04T00:00:00Z',
      url: 'https://github.com/test/repo/pull/104',
    },
    {
      number: 105,
      title: 'feat: owner pr',
      author: { login: 'xiufengsun', name: 'Rocky', is_bot: false },
      mergedAt: '2026-09-05T00:00:00Z',
      url: 'https://github.com/test/repo/pull/105',
    },
  ];

  const contributors = dist.extractContributors(mockPrs, { repo: 'xiufengsun/TokenTracker' });
  assert.equal(contributors.length, 2);
  assert.equal(contributors[0].login, 'alice');
  assert.equal(contributors[0].prCount, 2);
  assert.equal(contributors[1].login, 'bob');
  assert.equal(contributors[1].prCount, 1);
});

test('bindCodes maps codes 1:1 and generates spare codes properly', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-dist-test-'));
  const batchFile = path.join(tempDir, 'mock-batch.json');

  const mockBatch = {
    version: 1,
    batchId: 'e2a86847-92e1-45fe-82cb-7dc8e6c78111',
    environment: 'sandbox',
    durationDays: 365,
    redeemBefore: '2027-10-31T23:59:59.000Z',
    codes: [
      { code: 'TT-PRO-11111111-22222222-33333333-44444444', code_hash: 'h1', suffix: '44444444' },
      { code: 'TT-PRO-55555555-66666666-77777777-88888888', code_hash: 'h2', suffix: '88888888' },
      { code: 'TT-PRO-99999999-AAAAAAAA-BBBBBBBB-CCCCCCCC', code_hash: 'h3', suffix: 'CCCCCCCC' },
    ],
  };
  await fs.writeFile(batchFile, JSON.stringify(mockBatch));

  const mockContributors = [
    {
      login: 'alice',
      name: 'Alice A',
      prCount: 2,
      latestPr: { number: 102, title: 'feat: a' },
      preferredEmail: 'alice@example.com',
      hasDirectEmail: true,
    },
    {
      login: 'bob',
      name: 'Bob B',
      prCount: 1,
      latestPr: { number: 103, title: 'feat: b' },
      preferredEmail: '',
      hasDirectEmail: false,
    },
  ];

  const bound = await dist.bindCodes(mockContributors, batchFile, {});
  assert.equal(bound.totalContributors, 2);
  assert.equal(bound.allocatedCount, 2);
  assert.equal(bound.spareCount, 1);
  assert.equal(bound.allocations[0].login, 'alice');
  assert.equal(bound.allocations[0].code, mockBatch.codes[0].code);
  assert.equal(bound.allocations[1].login, 'bob');
  assert.equal(bound.allocations[1].code, mockBatch.codes[1].code);
  assert.equal(bound.spareCodes[0].code, mockBatch.codes[2].code);

  const formatted = dist.formatContributorMessages(bound.allocations);
  assert.equal(formatted.emailTemplates.length, 2);
  assert.equal(formatted.prCommentTemplates.length, 2);
  assert.ok(formatted.emailTemplates[0].body.includes(mockBatch.codes[0].code));
  assert.ok(formatted.communityAnnouncementMarkdown.includes('@alice'));
  assert.ok(formatted.communityAnnouncementMarkdown.includes('@bob'));
});
