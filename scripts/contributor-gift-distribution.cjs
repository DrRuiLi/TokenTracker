#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { privatePath } = require('./pro-gift-codes.cjs');

const HELP = `Usage: node scripts/contributor-gift-distribution.cjs <command> [options]

Commands:
  list-contributors      拉取并输出所有 Merged PR 贡献者列表与统计
  recommend-batch        根据贡献者数量计算并输出推荐的 pro-gift-codes 生成命令
  bind-codes             将生成的私有批次兑换码与贡献者进行 1:1 专属分配并生成分发表
  format-messages        为贡献者生成致谢邮件、PR 回复与公告模版
  verify                 校验分配表的完整性与码唯一性

Options:
  --repo OWNER/REPO      指定 GitHub 仓库（默认: xiufengsun/TokenTracker）
  --input-prs FILE       使用预先保存的 PR JSON 文件（离线或测试使用）
  --batch-file FILE      pro-gift-codes.cjs 生成的私有批次 JSON 文件路径
  --allocation-file FILE 专属分配结果 JSON 文件路径
  --out-file FILE        输出结果文件路径（如分配表或文案）
  --format TYPE          输出格式: table | json | markdown | csv (默认: table)
  --include-owner        是否包含仓库所有者（默认: 排除）
  --environment ENV      环境标识: sandbox | live (默认: live)
  --days DAYS            权益天数 (默认: 365)
  --buffer NUM           在贡献者人数基础上额外预留的缓冲码数量 (默认: 10)
  --show-codes           在控制台输出中显示完整明文兑换码（默认: 脱敏）
`;

function parseArgs(argv) {
  if (argv.includes('--help') || argv.length === 0) return { help: true };
  const [command, ...args] = argv;
  const validCommands = ['list-contributors', 'recommend-batch', 'bind-codes', 'format-messages', 'verify'];
  if (!validCommands.includes(command)) {
    throw Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
  const values = {
    repo: 'xiufengsun/TokenTracker',
    format: 'table',
    environment: 'live',
    days: 365,
    buffer: 10,
    includeOwner: false,
    showCodes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--include-owner') {
      values.includeOwner = true;
    } else if (arg === '--show-codes') {
      values.showCodes = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[++i];
      if (!val || val.startsWith('--')) throw Error(`Missing value for option ${arg}`);
      if (key === 'repo') values.repo = val;
      else if (key === 'input-prs') values.inputPrs = val;
      else if (key === 'batch-file') values.batchFile = val;
      else if (key === 'allocation-file') values.allocationFile = val;
      else if (key === 'out-file') values.outFile = val;
      else if (key === 'format') values.format = val;
      else if (key === 'environment') values.environment = val;
      else if (key === 'days') values.days = Number(val);
      else if (key === 'buffer') values.buffer = Number(val);
      else throw Error(`Unknown option: ${arg}`);
    }
  }
  return { command, ...values };
}

function fetchMergedPrs(repo, inputPrsFile) {
  if (inputPrsFile) {
    const raw = require('node:fs').readFileSync(path.resolve(inputPrsFile), 'utf8');
    return JSON.parse(raw);
  }
  const stdout = execFileSync('gh', [
    'pr', 'list',
    '--repo', repo,
    '--state', 'merged',
    '--limit', '1000',
    '--json', 'number,title,author,mergedAt,url,mergeCommit',
  ], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

function extractContributors(prs, { repo = 'xiufengsun/TokenTracker', includeOwner = false } = {}) {
  const [owner] = repo.split('/');
  const contributors = new Map();

  for (const pr of prs) {
    const author = pr.author;
    if (!author) continue;
    const login = author.login || '';
    if (!login) continue;

    // 过滤机器人
    if (author.is_bot || login.includes('[bot]') || login.startsWith('app/')) continue;
    // 过滤 owner（除非显式指定包含）
    if (!includeOwner && login.toLowerCase() === owner.toLowerCase()) continue;

    if (!contributors.has(login)) {
      contributors.set(login, {
        login,
        name: author.name || '',
        prCount: 0,
        prs: [],
        emails: new Set(),
      });
    }

    const c = contributors.get(login);
    c.prCount++;
    c.prs.push({
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
      url: pr.url,
      mergeCommitOid: pr.mergeCommit?.oid || '',
    });
  }

  // 尝试从 git 历史中提取真实提交邮箱
  for (const [login, c] of contributors) {
    try {
      const gitOut = execFileSync('git', [
        'log', `--author=${login}`, '-n', '20', '--pretty=format:%an|%ae',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (gitOut) {
        for (const line of gitOut.split('\n')) {
          const parts = line.split('|');
          if (parts[1]) {
            c.emails.add(parts[1].trim());
            if (!c.name && parts[0]) c.name = parts[0].trim();
          }
        }
      }
    } catch {
      // 忽略 Git 历史扫描异常
    }

    // 若依然为空，检查前几个 PR 的 merge commit
    if (c.emails.size === 0) {
      for (const pr of c.prs.slice(0, 3)) {
        if (!pr.mergeCommitOid) continue;
        try {
          const commitOut = execFileSync('git', [
            'show', '-s', '--pretty=format:%an|%ae', pr.mergeCommitOid,
          ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          if (commitOut) {
            const parts = commitOut.split('|');
            if (parts[1] && !parts[1].toLowerCase().includes(owner.toLowerCase())) {
              c.emails.add(parts[1].trim());
              if (!c.name && parts[0]) c.name = parts[0].trim();
            }
          }
        } catch {}
      }
    }
  }

  const list = Array.from(contributors.values()).map(c => {
    const allEmails = Array.from(c.emails);
    const directEmails = allEmails.filter(e => !e.includes('noreply.github.com') && !e.endsWith('.local') && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e));
    const preferredEmail = directEmails[0] || allEmails[0] || '';
    return {
      login: c.login,
      name: c.name || c.login,
      prCount: c.prCount,
      prs: c.prs,
      latestPr: c.prs[0],
      emails: allEmails,
      directEmails,
      preferredEmail,
      hasDirectEmail: directEmails.length > 0,
    };
  });

  // 按 PR 数量降序排序，相同数量按用户名升序
  list.sort((a, b) => b.prCount - a.prCount || a.login.localeCompare(b.login));
  return list;
}

function recommendBatchCommand(contributors, options) {
  const count = contributors.length + (options.buffer || 0);
  const expiryDate = new Date();
  expiryDate.setFullYear(expiryDate.getFullYear() + 1);
  expiryDate.setHours(23, 59, 59, 0);
  const expiresIso = expiryDate.toISOString();
  const label = 'github-contributors-pr-merged-1y';
  const outPath = options.outFile || path.resolve('.tmp/contributor-gift-codes.json');

  return {
    contributorsCount: contributors.length,
    buffer: options.buffer || 0,
    recommendedTotal: count,
    days: options.days || 365,
    expires: expiresIso,
    label,
    outPath,
    cliCommand: `node scripts/pro-gift-codes.cjs generate \\\n  --environment ${options.environment || 'live'} \\\n  --days ${options.days || 365} \\\n  --count ${count} \\\n  --expires "${expiresIso}" \\\n  --label "${label}" \\\n  --out "${outPath}"`,
  };
}

async function bindCodes(contributors, batchFile, options) {
  if (!batchFile) throw Error('Please provide --batch-file pointing to the private batch JSON');
  const resolved = path.resolve(batchFile);
  const raw = await fs.readFile(resolved, 'utf8');
  const batch = JSON.parse(raw);

  if (!batch.codes || !Array.isArray(batch.codes)) {
    throw Error('Invalid batch file: missing codes array');
  }
  if (batch.codes.length < contributors.length) {
    throw Error(`Batch code count (${batch.codes.length}) is less than contributor count (${contributors.length})`);
  }

  const allocations = contributors.map((c, index) => {
    const item = batch.codes[index];
    return {
      index: index + 1,
      login: c.login,
      name: c.name,
      prCount: c.prCount,
      latestPrNumber: c.latestPr?.number,
      latestPrTitle: c.latestPr?.title,
      latestPrUrl: c.latestPr?.url,
      preferredEmail: c.preferredEmail,
      hasDirectEmail: c.hasDirectEmail,
      code: item.code,
      codeSuffix: item.suffix,
      codeHash: item.code_hash,
      durationDays: batch.durationDays,
      redeemBefore: batch.redeemBefore,
      batchId: batch.batchId,
      status: 'pending',
    };
  });

  const spareCodes = batch.codes.slice(contributors.length).map(item => ({
    code: item.code,
    codeSuffix: item.suffix,
    codeHash: item.code_hash,
    durationDays: batch.durationDays,
    redeemBefore: batch.redeemBefore,
    batchId: batch.batchId,
    status: 'unallocated',
  }));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    batchId: batch.batchId,
    environment: batch.environment,
    durationDays: batch.durationDays,
    redeemBefore: batch.redeemBefore,
    totalContributors: contributors.length,
    totalCodesInBatch: batch.codes.length,
    allocatedCount: allocations.length,
    spareCount: spareCodes.length,
    allocations,
    spareCodes,
  };
}

function maskCode(code) {
  if (!code) return '';
  const parts = code.split('-');
  if (parts.length < 3) return code;
  return `${parts[0]}-${parts[1]}-****-****-****-${parts[parts.length - 1]}`;
}

function formatContributorMessages(allocations) {
  const result = {
    emailTemplates: [],
    prCommentTemplates: [],
    communityAnnouncementMarkdown: '',
  };

  for (const item of allocations) {
    const redeemDate = item.redeemBefore.slice(0, 10);
    // 邮件正文模版
    const emailBody = `Hi @${item.login} (${item.name}),

感谢你对 TokenTracker 的开源贡献！你在 PR #${item.latestPrNumber} (${item.latestPrTitle}) 中贡献的代码，一直稳定运行在许许多多开发者的终端与桌面上。

如你可能已经注意到的，我们近期将原本免费的多端同步功能升级为了收费的 TokenTracker Cloud 云服务。在这里，我想坦诚地与你同步这个决策背后的原因：

随着 TokenTracker 用户规模的迅速扩大，多端高频同步与云端聚合分析的数据用量呈现出爆发式增长。随之而来的服务器计算、数据库存储与边缘带宽成本急剧攀升，每月的账单开销已经远远超出了我个人自费能够承受的极限。为了保证服务的可用性与稳定性，让项目能够长久、健康、可持续地走下去，而不是因为高昂的基础设施开销而被迫停服，我们最终不得不将多端同步升级为商业化的云服务模式。

但无论后续如何发展，我都绝不会忘记一路走来为 TokenTracker 贡献过代码、提交过 PR 的开源伙伴。没有大家的共同维护与付出，TokenTracker 绝不可能成长为今天的样子。因此，我无论如何都要为每一位成功合并过代码的贡献者，免费送上为期 1 年（365 天）的 TokenTracker Cloud 会员权益：

- 专属兑换码: ${item.code}
- 权益时长: 365 天（自兑换成功起计算）
- 兑换截止日: ${redeemDate} 前有效

兑换方式:
1. 打开 TokenTracker 桌面客户端或登录 Web 控制台;
2. 进入「设置」->「云服务」页面，登录你的账号;
3. 点击「兑换云服务码」，输入上方专属兑换码即可立即激活。

再次由衷感谢你对 TokenTracker 的支持与陪伴。希望全新升级的云服务能够为你的日常编码带来便利，也期待未来能与你在开源社区继续同行！

TokenTracker 维护者 / Rocky
`;

    // PR 评论通知模版（不含明文码，安全引导）
    const prComment = `Hi @${item.login}，再次感谢你为 TokenTracker 贡献的 PR #${item.latestPrNumber}！
如你所见，近期由于用量激增导致服务器成本超出了个人承担极限，我们将多端同步升级为了收费的 Cloud 云服务。但无论如何，我都非常感谢一路为项目贡献代码的开发者。
我们已为你预留了一份专属的 1 年 Cloud 会员兑换码。为防止公开泄露，兑换码未直接贴在此处：
- 若你在 Git 提交中登记了有效邮箱，我们已尝试发送至你的邮箱 (${item.preferredEmail || '未检测到公开外网邮箱'})；
- 若你使用的是隐私邮箱或未收到，欢迎邮件联系我或直接在此回复确认，我们将安全交付你的专属兑换码。`;

    result.emailTemplates.push({
      login: item.login,
      email: item.preferredEmail,
      subject: `[TokenTracker] 感谢你的开源贡献：为你送上 1 年 Cloud 会员兑换码`,
      body: emailBody,
    });

    result.prCommentTemplates.push({
      login: item.login,
      prNumber: item.latestPrNumber,
      comment: prComment,
    });
  }

  // 社区公告 Markdown 模版
  const namesList = allocations.map((item, idx) => `${idx + 1}. @${item.login} (PR #${item.latestPrNumber})`).join('\n');
  result.communityAnnouncementMarkdown = `# 致 TokenTracker 开源贡献者：1 年 Cloud 会员感恩计划

TokenTracker 现已正式推出 Cloud 多端同步与云端服务。在此，我们想坦诚地与大家分享做出收费决定的初衷，并向所有开源贡献者送上专属回馈。

## 为什么云服务会收费？
自 TokenTracker 发布以来，用户规模与多端高频同步用量爆发式增长。随之而来的是高昂的云端数据库、边缘网络与服务器运维开销，账单成本已经远远超出了维护者个人能够无偿承受的范围。为了保证多端同步服务的稳定性与高可用，让项目能够长久、健康、可持续地运转下去，而不是因为资金断裂而关停，我们最终决定将多端同步升级为商业化的 Cloud 会员服务。

## 专属回馈：向所有代码贡献者赠送 1 年会员
开源是 TokenTracker 的立足之本。无论商业化走向何方，我们都绝不会忘记在每一个版本中提交 PR、修复 bug、增添特性的贡献者们。

我们特别为历史上所有提交过 PR 并被合并的代码贡献者准备了专属回馈：**每人免费赠送 1 年 TokenTracker Cloud 会员（365 天时长）**。

### 贡献者致谢名单（共 ${allocations.length} 位）

${namesList}

### 领取与兑换说明
- **已留公开邮箱的贡献者**：我们已通过邮件将专属兑换码发送至你在 Git 提交中登记的邮箱，请查收邮件；
- **使用 GitHub 隐私代理邮箱或未收到邮件的贡献者**：请使用你的 GitHub 账户在本项目发起认领 Issue，或直接发送邮件至维护者邮箱，核验 GitHub ID 后我们将为你分发专属兑换码；
- **兑换指引**：在客户端或 Web 控制台登录后，进入「设置」->「云服务」，输入兑换码即可直接开通 365 天会员。

感谢大家与 TokenTracker 一路同行！
`;

  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.command === 'list-contributors') {
    const prs = fetchMergedPrs(options.repo, options.inputPrs);
    const contributors = extractContributors(prs, options);

    if (options.format === 'json') {
      process.stdout.write(JSON.stringify(contributors, null, 2) + '\n');
    } else if (options.format === 'markdown') {
      process.stdout.write(`### TokenTracker Merged PR 贡献者列表 (共 ${contributors.length} 人)\n\n`);
      process.stdout.write('| 序号 | GitHub ID | 姓名 | 合并 PR 数 | 最新 PR | 邮箱识别 |\n');
      process.stdout.write('| :--- | :--- | :--- | :--- | :--- | :--- |\n');
      contributors.forEach((c, idx) => {
        process.stdout.write(`| ${idx + 1} | @${c.login} | ${c.name} | ${c.prCount} | [#${c.latestPr?.number}](${c.latestPr?.url}) | ${c.preferredEmail || '无'} |\n`);
      });
    } else {
      process.stdout.write(`\n=== TokenTracker Merged PR 贡献者分析 ===\n`);
      process.stdout.write(`仓库: ${options.repo}\n`);
      process.stdout.write(`总计独立贡献者: ${contributors.length} 人\n`);
      const withDirectEmail = contributors.filter(c => c.hasDirectEmail).length;
      process.stdout.write(`含有效直接邮箱: ${withDirectEmail} 人\n`);
      process.stdout.write(`仅 noreply/无邮箱: ${contributors.length - withDirectEmail} 人\n\n`);
      process.stdout.write(`TOP 15 贡献者:\n`);
      contributors.slice(0, 15).forEach((c, idx) => {
        process.stdout.write(`  ${String(idx + 1).padStart(2, ' ')}. @${c.login.padEnd(16, ' ')} (${c.prCount} PRs) - ${c.preferredEmail || '无公开邮箱'}\n`);
      });
      process.stdout.write(`\n使用 --format markdown 或 --format json 可查看完整清单。\n`);
    }
  } else if (options.command === 'recommend-batch') {
    const prs = fetchMergedPrs(options.repo, options.inputPrs);
    const contributors = extractContributors(prs, options);
    const rec = recommendBatchCommand(contributors, options);

    process.stdout.write(`\n=== 推荐的兑换码生成配置 ===\n`);
    process.stdout.write(`当前合格贡献者数: ${rec.contributorsCount} 人\n`);
    process.stdout.write(`缓冲预留数量: ${rec.buffer} 个\n`);
    process.stdout.write(`建议生成总数: ${rec.recommendedTotal} 个\n`);
    process.stdout.write(`单码权益天数: ${rec.days} 天 (1年)\n`);
    process.stdout.write(`兑换截止期限: ${rec.expires}\n`);
    process.stdout.write(`私有输出路径: ${rec.outPath}\n\n`);
    process.stdout.write(`请执行以下命令完成真实批次生成（需配置 InsForge 密钥）:\n\n`);
    process.stdout.write(`${rec.cliCommand}\n\n`);
  } else if (options.command === 'bind-codes') {
    const prs = fetchMergedPrs(options.repo, options.inputPrs);
    const contributors = extractContributors(prs, options);
    const result = await bindCodes(contributors, options.batchFile, options);

    const outPath = options.outFile || path.resolve('.tmp/contributor-allocation.json');
    const safeFile = await privatePath(outPath, true);
    await fs.writeFile(safeFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });

    process.stdout.write(`\n=== 兑换码 1:1 分配绑定完成 ===\n`);
    process.stdout.write(`批次 ID: ${result.batchId}\n`);
    process.stdout.write(`分配贡献者数: ${result.allocatedCount} 人\n`);
    process.stdout.write(`剩余未分配备用码: ${result.spareCount} 个\n`);
    process.stdout.write(`分配明细已写入私有文件: ${safeFile} (0600 权限)\n\n`);
  } else if (options.command === 'format-messages') {
    if (!options.allocationFile) {
      throw Error('Please provide --allocation-file pointing to the private allocation JSON');
    }
    const raw = await fs.readFile(path.resolve(options.allocationFile), 'utf8');
    const data = JSON.parse(raw);
    const messages = formatContributorMessages(data.allocations);

    if (options.outFile) {
      const safeFile = await privatePath(options.outFile, true);
      await fs.writeFile(safeFile, JSON.stringify(messages, null, 2) + '\n', { mode: 0o600 });
      process.stdout.write(`文案模版已保存至私有文件: ${safeFile}\n`);
    } else {
      process.stdout.write(`\n=== 社区致谢与认领公告模版 ===\n\n`);
      process.stdout.write(messages.communityAnnouncementMarkdown);
      process.stdout.write(`\n=== 单人邮件文案示例 (@${data.allocations[0]?.login}) ===\n\n`);
      process.stdout.write(messages.emailTemplates[0]?.body || '无数据');
    }
  } else if (options.command === 'verify') {
    if (!options.allocationFile) {
      throw Error('Please provide --allocation-file');
    }
    const raw = await fs.readFile(path.resolve(options.allocationFile), 'utf8');
    const data = JSON.parse(raw);
    const codes = new Set();
    const logins = new Set();
    let hasDup = false;

    for (const item of data.allocations) {
      if (codes.has(item.code)) {
        process.stderr.write(`Error: Duplicate code found: ${item.code}\n`);
        hasDup = true;
      }
      if (logins.has(item.login)) {
        process.stderr.write(`Error: Duplicate login found: ${item.login}\n`);
        hasDup = true;
      }
      codes.add(item.code);
      logins.add(item.login);
    }
    if (hasDup) throw Error('Verification failed: duplicate entries detected');
    process.stdout.write(`Verify OK: ${data.allocations.length} unique contributors mapped to unique codes.\n`);
  }
}

module.exports = {
  parseArgs,
  fetchMergedPrs,
  extractContributors,
  recommendBatchCommand,
  bindCodes,
  formatContributorMessages,
  main,
};

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
