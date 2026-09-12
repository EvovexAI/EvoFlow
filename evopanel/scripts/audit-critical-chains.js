#!/usr/bin/env node

/**
 * Lighthouse Critical Request Chains Audit Script
 * 
 * Performs performance audits on target URLs, extracts critical request chains,
 * main thread blocking time, and analyzes preload strategy effectiveness.
 * 
 * Usage:
 *   node audit-critical-chains.js --url=https://example.com/dashboard
 *   node audit-critical-chains.js --url=https://example.com --device=mobile --output=json
 */

const puppeteer = require('puppeteer');
const lighthouse = require('lighthouse');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: 'https://staging.evopanel.com/dashboard',
    device: 'mobile',
    output: 'text',
    outputPath: null,
    chromeFlags: [],
  };

  for (const arg of args) {
    if (arg.startsWith('--url=')) {
      config.url = arg.slice(6);
    } else if (arg.startsWith('--device=')) {
      config.device = arg.slice(9);
    } else if (arg.startsWith('--output=')) {
      config.output = arg.slice(9);
    } else if (arg.startsWith('--output-path=')) {
      config.outputPath = arg.slice(14);
    } else if (arg.startsWith('--chrome-flag=')) {
      config.chromeFlags.push(arg.slice(14));
    }
  }

  return config;
}

// Device emulation presets
const DEVICE_PRESETS = {
  mobile: {
    screenEmulation: {
      width: 412,
      height: 823,
      deviceScaleFactor: 2.625,
      mobile: true,
    },
    throttling: {
      rttMs: 150,
      throughputKbps: 1638.4,
      cpuSlowdownMultiplier: 4,
    },
  },
  desktop: {
    screenEmulation: {
      width: 1350,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    },
    throttling: {
      rttMs: 40,
      throughputKbps: 10240,
      cpuSlowdownMultiplier: 1,
    },
  },
};

// Run Lighthouse audit
async function runAudit(url, device) {
  console.log(`🔍 Starting Lighthouse audit for: ${url}`);
  console.log(`📱 Device preset: ${device}`);

  const chrome = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    headless: 'new',
  });

  try {
    const { port } = new URL(chrome.wsEndpoint());
    
    const lighthouseConfig = {
      extends: 'lighthouse:default',
      settings: {
        ...DEVICE_PRESETS[device],
        onlyCategories: ['performance'],
        output: 'json',
        formFactor: device === 'mobile' ? 'mobile' : 'desktop',
      },
    };

    const result = await lighthouse(url, {
      port,
      output: 'json',
      ...lighthouseConfig.settings,
    });

    return result;
  } finally {
    await chrome.close();
  }
}

// Extract critical request chains
function extractCriticalChains(lhr) {
  const criticalChains = lhr.audits['critical-request-chains'];
  
  if (!criticalChains || !criticalChains.details) {
    return { chains: [], summary: 'No critical request chains found' };
  }

  const chains = criticalChains.details.chains || [];
  
  // Flatten and sort by duration
  const flattenedChains = [];
  
  function flattenChain(chain, depth = 0, parentDuration = 0) {
    if (!chain) return;
    
    const request = chain.request;
    if (request) {
      flattenedChains.push({
        url: request.url,
        duration: request.endTime - request.startTime,
        transferSize: request.transferSize,
        resourceType: request.resourceType,
        depth,
        priority: request.priority,
      });
    }
    
    if (chain.children) {
      for (const child of Object.values(chain.children)) {
        flattenChain(child, depth + 1, request ? request.endTime - request.startTime : 0);
      }
    }
  }
  
  for (const chain of chains) {
    flattenChain(chain);
  }
  
  // Sort by duration descending
  flattenedChains.sort((a, b) => b.duration - a.duration);
  
  return {
    chains: flattenedChains,
    totalChains: chains.length,
    maxDepth: Math.max(...flattenedChains.map(c => c.depth), 0),
  };
}

// Extract main thread blocking time
function extractMainThreadBlocking(lhr) {
  const mainThreadWork = lhr.audits['mainthread-work-breakdown'];
  const blockingTime = lhr.audits['total-blocking-time'];
  
  return {
    totalBlockingTime: blockingTime?.numericValue || 0,
    blockingTimeScore: blockingTime?.score || 0,
    mainThreadTasks: mainThreadWork?.details?.items || [],
    topTasks: (mainThreadWork?.details?.items || [])
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5),
  };
}

// Analyze preload/prefetch/preconnect strategy
function analyzePreloadStrategy(lhr) {
  const networkRequests = lhr.audits['network-requests'];
  const items = networkRequests?.details?.items || [];
  
  const preloadResources = items.filter(item => 
    item.resourceType === 'Document' && 
    (item.url.includes('preload') || item.url.includes('prefetch'))
  );
  
  const criticalResources = items.filter(item => 
    item.priority === 'VeryHigh' || item.priority === 'High'
  );
  
  const preconnectLinks = items.filter(item =>
    item.resourceType === 'Other' && 
    item.url.includes('preconnect')
  );
  
  return {
    preloadCount: preloadResources.length,
    preconnectCount: preconnectLinks.length,
    criticalResources: criticalResources.length,
    preloadResources: preloadResources.map(r => ({
      url: r.url,
      type: r.resourceType,
      size: r.transferSize,
    })),
    recommendations: generatePreloadRecommendations(criticalResources, preloadResources),
  };
}

// Generate preload recommendations
function generatePreloadRecommendations(criticalResources, preloadResources) {
  const recommendations = [];
  
  const criticalUrls = new Set(criticalResources.map(r => r.url));
  const preloadedUrls = new Set(preloadResources.map(r => r.url));
  
  // Find critical resources that are not preloaded
  for (const url of criticalUrls) {
    if (!preloadedUrls.has(url)) {
      recommendations.push({
        type: 'preload',
        url,
        reason: 'Critical resource not preloaded',
        priority: 'high',
      });
    }
  }
  
  return recommendations;
}

// Extract top 5 blocking resources
function extractTopBlockingResources(lhr) {
  const networkRequests = lhr.audits['network-requests'];
  const items = networkRequests?.details?.items || [];
  
  // Calculate blocking time for each resource
  const resourcesWithBlocking = items.map(item => {
    const startTime = item.startTime || 0;
    const endTime = item.endTime || 0;
    const duration = endTime - startTime;
    
    return {
      url: item.url,
      resourceType: item.resourceType,
      duration,
      transferSize: item.transferSize,
      priority: item.priority,
      startTime,
      endTime,
      blockingTime: Math.max(0, duration - 50), // Assume 50ms threshold
    };
  });
  
  // Sort by blocking time
  resourcesWithBlocking.sort((a, b) => b.blockingTime - a.blockingTime);
  
  return resourcesWithBlocking.slice(0, 5);
}

// Generate text report
function generateTextReport(url, device, chains, mainThread, preload, topBlocking) {
  const lines = [];
  
  lines.push('='.repeat(80));
  lines.push('LIGHTHOUSE CRITICAL REQUEST CHAINS AUDIT REPORT');
  lines.push('='.repeat(80));
  lines.push('');
  lines.push(`Target URL: ${url}`);
  lines.push(`Device Preset: ${device}`);
  lines.push(`Audit Time: ${new Date().toISOString()}`);
  lines.push('');
  
  // Critical Chains Summary
  lines.push('-'.repeat(80));
  lines.push('CRITICAL REQUEST CHAINS');
  lines.push('-'.repeat(80));
  lines.push(`Total Chains: ${chains.totalChains}`);
  lines.push(`Maximum Depth: ${chains.maxDepth}`);
  lines.push('');
  
  if (chains.chains.length > 0) {
    lines.push('Top Critical Requests:');
    chains.chains.slice(0, 10).forEach((chain, i) => {
      lines.push(`  ${i + 1}. [${chain.resourceType}] ${chain.url}`);
      lines.push(`     Duration: ${chain.duration.toFixed(2)}ms | Size: ${chain.transferSize} bytes`);
      lines.push(`     Depth: ${chain.depth} | Priority: ${chain.priority}`);
    });
  }
  lines.push('');
  
  // Main Thread Blocking
  lines.push('-'.repeat(80));
  lines.push('MAIN THREAD BLOCKING');
  lines.push('-'.repeat(80));
  lines.push(`Total Blocking Time: ${mainThread.totalBlockingTime.toFixed(2)}ms`);
  lines.push(`Score: ${(mainThread.blockingTimeScore * 100).toFixed(0)}/100`);
  lines.push('');
  
  if (mainThread.topTasks.length > 0) {
    lines.push('Top Blocking Tasks:');
    mainThread.topTasks.forEach((task, i) => {
      lines.push(`  ${i + 1}. ${task.group || task.url}`);
      lines.push(`     Duration: ${task.duration.toFixed(2)}ms`);
    });
  }
  lines.push('');
  
  // Top 5 Blocking Resources
  lines.push('-'.repeat(80));
  lines.push('TOP 5 BLOCKING RESOURCES');
  lines.push('-'.repeat(80));
  
  topBlocking.forEach((resource, i) => {
    lines.push(`  ${i + 1}. [${resource.resourceType}] ${resource.url}`);
    lines.push(`     Duration: ${resource.duration.toFixed(2)}ms | Blocking: ${resource.blockingTime.toFixed(2)}ms`);
    lines.push(`     Size: ${resource.transferSize} bytes | Priority: ${resource.priority}`);
    lines.push(`     Timing: ${resource.startTime.toFixed(2)}ms → ${resource.endTime.toFixed(2)}ms`);
  });
  lines.push('');
  
  // Preload Strategy Analysis
  lines.push('-'.repeat(80));
  lines.push('PRELOAD STRATEGY ANALYSIS');
  lines.push('-'.repeat(80));
  lines.push(`Preload Resources: ${preload.preloadCount}`);
  lines.push(`Preconnect Links: ${preload.preconnectCount}`);
  lines.push(`Critical Resources: ${preload.criticalResources}`);
  lines.push('');
  
  if (preload.recommendations.length > 0) {
    lines.push('Recommendations:');
    preload.recommendations.forEach((rec, i) => {
      lines.push(`  ${i + 1}. [${rec.priority.toUpperCase()}] ${rec.reason}`);
      lines.push(`     URL: ${rec.url}`);
    });
  } else {
    lines.push('✓ No preload recommendations - current strategy looks good!');
  }
  lines.push('');
  
  lines.push('='.repeat(80));
  
  return lines.join('\n');
}

// Main execution
async function main() {
  const config = parseArgs();
  
  try {
    // Validate URL
    new URL(config.url);
    
    // Run audit
    const lhr = await runAudit(config.url, config.device);
    
    // Extract data
    const chains = extractCriticalChains(lhr.lhr);
    const mainThread = extractMainThreadBlocking(lhr.lhr);
    const preload = analyzePreloadStrategy(lhr.lhr);
    const topBlocking = extractTopBlockingResources(lhr.lhr);
    
    // Generate output
    if (config.output === 'json') {
      const jsonOutput = {
        url: config.url,
        device: config.device,
        timestamp: new Date().toISOString(),
        criticalChains: chains,
        mainThreadBlocking: mainThread,
        preloadStrategy: preload,
        topBlockingResources: topBlocking,
        performanceScore: lhr.lhr.categories.performance.score,
      };
      
      const jsonStr = JSON.stringify(jsonOutput, null, 2);
      
      if (config.outputPath) {
        fs.writeFileSync(config.outputPath, jsonStr, 'utf-8');
        console.log(`✓ JSON report saved to: ${config.outputPath}`);
      } else {
        console.log(jsonStr);
      }
    } else {
      const textReport = generateTextReport(
        config.url,
        config.device,
        chains,
        mainThread,
        preload,
        topBlocking
      );
      
      if (config.outputPath) {
        fs.writeFileSync(config.outputPath, textReport, 'utf-8');
        console.log(`✓ Text report saved to: ${config.outputPath}`);
      } else {
        console.log(textReport);
      }
    }
    
    console.log('\n✓ Audit completed successfully');
    
  } catch (error) {
    console.error('✗ Audit failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
