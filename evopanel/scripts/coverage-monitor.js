#!/usr/bin/env node

/**
 * Coverage Monitor Sidecar
 * 非侵入式覆盖率监控旁路 - 读取 coverage-summary.json，对比阈值并记录趋势
 * 
 * 用法: node scripts/coverage-monitor.js [--threshold=80] [--summary-path=coverage/coverage-summary.json]
 */

import { createCoverageMap } from 'istanbul-lib-coverage';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 解析命令行参数
const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultValue;
};

const THRESHOLD = parseInt(getArg('threshold', '80'));
const COVERAGE_SUMMARY_PATH = resolve(__dirname, '..', getArg('summary-path', 'coverage/coverage-summary.json'));
const LOG_DIR = resolve(__dirname, '..', 'logs');
const TREND_LOG_PATH = resolve(LOG_DIR, 'coverage-trend.log');

// ANSI 颜色代码
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}${colors.bold}⚠ WARN:${colors.reset} ${colors.yellow}${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}${colors.bold}✖ ERROR:${colors.reset} ${colors.red}${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✔${colors.reset} ${msg}`),
};

/**
 * 读取并解析 coverage-summary.json
 */
function readCoverageSummary() {
  if (!existsSync(COVERAGE_SUMMARY_PATH)) {
    log.error(`覆盖率报告不存在: ${COVERAGE_SUMMARY_PATH}`);
    log.info('请先运行测试并生成覆盖率报告，例如: npm run test -- --coverage');
    process.exit(1);
  }

  try {
    const content = readFileSync(COVERAGE_SUMMARY_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    log.error(`解析覆盖率报告失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * 使用 istanbul-lib-coverage 创建覆盖率映射
 */
function createCoverageMapping(summaryData) {
  const coverageMap = createCoverageMap(summaryData);
  return coverageMap;
}

/**
 * 提取总覆盖率数据
 */
function extractTotalCoverage(summaryData) {
  const total = summaryData.total;
  if (!total) {
    log.error('覆盖率报告中缺少 total 字段');
    process.exit(1);
  }

  return {
    lines: total.lines?.pct ?? 0,
    statements: total.statements?.pct ?? 0,
    functions: total.functions?.pct ?? 0,
    branches: total.branches?.pct ?? 0,
  };
}

/**
 * 检查覆盖率是否低于阈值
 */
function checkThreshold(coverage) {
  const warnings = [];
  const metrics = ['lines', 'statements', 'functions', 'branches'];

  for (const metric of metrics) {
    const value = coverage[metric];
    if (value < THRESHOLD) {
      warnings.push({
        metric,
        value,
        threshold: THRESHOLD,
        gap: (THRESHOLD - value).toFixed(2),
      });
    }
  }

  return warnings;
}

/**
 * 打印覆盖率报告
 */
function printCoverageReport(coverage, warnings) {
  console.log('\n' + colors.bold + '═══════════════════════════════════════════════════════════' + colors.reset);
  console.log(colors.bold + '                    覆盖率监控报告' + colors.reset);
  console.log(colors.bold + '═══════════════════════════════════════════════════════════' + colors.reset + '\n');

  const metrics = [
    { name: 'Statements (语句)', value: coverage.statements },
    { name: 'Branches (分支)', value: coverage.branches },
    { name: 'Functions (函数)', value: coverage.functions },
    { name: 'Lines (行)', value: coverage.lines },
  ];

  for (const metric of metrics) {
    const color = metric.value >= THRESHOLD ? colors.green : colors.yellow;
    const status = metric.value >= THRESHOLD ? '✔' : '⚠';
    console.log(`${color}${status} ${metric.name.padEnd(25)} ${metric.value.toFixed(2)}%${colors.reset}`);
  }

  console.log('\n' + colors.bold + '───────────────────────────────────────────────────────────' + colors.reset);
  console.log(`${colors.cyan}阈值设置:${colors.reset} ${THRESHOLD}%`);
  console.log(colors.bold + '───────────────────────────────────────────────────────────' + colors.reset + '\n');

  if (warnings.length > 0) {
    log.warn(`发现 ${warnings.length} 项指标低于阈值 ${THRESHOLD}%:\n`);
    for (const warning of warnings) {
      console.log(`  ${colors.yellow}•${colors.reset} ${warning.metric.padEnd(15)} ${warning.value.toFixed(2)}% ${colors.red}(低于阈值 ${warning.gap}%)${colors.reset}`);
    }
    console.log();
  } else {
    log.success(`所有指标均达到或超过阈值 ${THRESHOLD}%`);
    console.log();
  }
}

/**
 * 记录覆盖率趋势到日志文件
 */
function logCoverageTrend(coverage, warnings) {
  // 确保日志目录存在
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const status = warnings.length > 0 ? 'WARN' : 'PASS';
  
  const trendEntry = [
    `\n[${timestamp}] [${status}]`,
    `  statements=${coverage.statements.toFixed(2)}%`,
    `  branches=${coverage.branches.toFixed(2)}%`,
    `  functions=${coverage.functions.toFixed(2)}%`,
    `  lines=${coverage.lines.toFixed(2)}%`,
    `  threshold=${THRESHOLD}%`,
    warnings.length > 0 ? `  warnings=${warnings.map(w => w.metric).join(',')}` : '',
  ].filter(Boolean).join('\n');

  try {
    appendFileSync(TREND_LOG_PATH, trendEntry + '\n');
    log.info(`覆盖率趋势已记录到: ${TREND_LOG_PATH}`);
  } catch (err) {
    log.warn(`无法写入趋势日志: ${err.message}`);
  }
}

/**
 * 主函数
 */
function main() {
  log.info('开始分析覆盖率报告...\n');

  // 读取覆盖率数据
  const summaryData = readCoverageSummary();
  
  // 创建覆盖率映射（用于验证数据完整性）
  const coverageMap = createCoverageMapping(summaryData);
  
  // 提取总覆盖率
  const coverage = extractTotalCoverage(summaryData);
  
  // 检查阈值
  const warnings = checkThreshold(coverage);
  
  // 打印报告
  printCoverageReport(coverage, warnings);
  
  // 记录趋势
  logCoverageTrend(coverage, warnings);

  // 输出最终状态（不阻断构建，仅提示）
  if (warnings.length > 0) {
    console.log(colors.yellow + colors.bold + '💡 提示: 覆盖率低于阈值，建议改进测试覆盖。' + colors.reset);
    console.log(colors.yellow + '   此警告不会阻断构建流程。' + colors.reset + '\n');
  } else {
    console.log(colors.green + colors.bold + '🎉 覆盖率达标，继续保持！' + colors.reset + '\n');
  }
}

// 执行
main();
