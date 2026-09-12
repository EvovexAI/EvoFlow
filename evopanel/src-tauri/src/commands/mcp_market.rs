//! 内置 MCP 市场精选列表（与 `evopanel/scripts/dev-api.js` 中 HOT_MCP_SERVERS 对齐；Web 开发走 dev-api，桌面走本命令）

use serde_json::{json, Value};

struct HotEntry {
    slug: &'static str,
    name: &'static str,
    description: &'static str,
    install_cmd: &'static str,
    stars: i32,
}

const HOT_MCP_SERVERS: &[HotEntry] = &[
    HotEntry { slug: "filesystem", name: "Filesystem", description: "读写本地文件系统，管理文件和目录操作", install_cmd: "npx -y @modelcontextprotocol/server-filesystem", stars: 9800 },
    HotEntry { slug: "fetch", name: "Web Fetch", description: "抓取网页内容，获取互联网上的任意 URL 数据", install_cmd: "npx -y @modelcontextprotocol/server-fetch", stars: 8700 },
    HotEntry { slug: "brave-search", name: "Brave Search", description: "使用 Brave Search 引擎进行实时网络搜索", install_cmd: "npx -y @modelcontextprotocol/server-brave-search", stars: 7500 },
    HotEntry { slug: "github", name: "GitHub MCP Server", description: "GitHub 仓库、Issue、PR、Actions 等全功能集成", install_cmd: "npx -y @modelcontextprotocol/server-github", stars: 7200 },
    HotEntry { slug: "puppeteer", name: "Puppeteer Browser", description: "基于 Chromium 的浏览器自动化，支持截图、点击、表单填写", install_cmd: "npx -y @anthropic/mcp-server-puppeteer", stars: 6500 },
    HotEntry { slug: "memory", name: "Memory Knowledge Graph", description: "持久化记忆存储，基于知识图谱的上下文管理", install_cmd: "npx -y @modelcontextprotocol/server-memory", stars: 6100 },
    HotEntry { slug: "postgres", name: "PostgreSQL", description: "PostgreSQL 数据库查询和管理，安全执行 SQL", install_cmd: "npx -y @modelcontextprotocol/server-postgres", stars: 5800 },
    HotEntry { slug: "slack", name: "Slack", description: "Slack 工作区消息收发、频道管理和用户信息获取", install_cmd: "npx -y @modelcontextprotocol/server-slack", stars: 5200 },
    HotEntry { slug: "sequential-thinking", name: "Sequential Thinking", description: "逐步推理思维链，增强复杂问题解决能力", install_cmd: "npx -y @modelcontextprotocol/server-sequentialthinking", stars: 4900 },
    HotEntry { slug: "docker", name: "Docker", description: "Docker 容器、镜像和网络管理，执行容器操作命令", install_cmd: "npx -y @modelcontextprotocol/server-docker", stars: 4600 },
    HotEntry { slug: "notion", name: "Notion", description: "Notion 页面、数据库和块级内容读写管理", install_cmd: "npx -y@mcp/notion-server", stars: 4300 },
    HotEntry { slug: "aws-kb-retrieval", name: "AWS Knowledge Base Retrieval", description: "从 Amazon Knowledge Bases 检索 RAG 知识文档", install_cmd: "npx -y @aws-sdk/mcp-server-kb-retrieval", stars: 4000 },
    HotEntry { slug: "gdrive", name: "Google Drive", description: "Google Drive 文件搜索、上传下载和权限管理", install_cmd: "npx -y @anthropic/mcp-server-google-drive", stars: 3800 },
    HotEntry { slug: "stripe", name: "Stripe", description: "Stripe 支付、账单、客户和产品数据查询", install_cmd: "npx -y @anthropic/mcp-server-stripe", stars: 3500 },
    HotEntry { slug: "everything", name: "Everything (Windows Search)", description: "Windows 本地文件极速搜索，基于 Everything 引擎", install_cmd: "npx -y mcp-server-everything", stars: 3200 },
    HotEntry { slug: "supabase", name: "Supabase", description: "Supabase 数据库、Auth 和 Storage 服务集成", install_cmd: "npx -y @supabase/mcp-supabase", stars: 3000 },
    HotEntry { slug: "obsidian", name: "Obsidian", description: "Obsidian 笔记库搜索、读取和链接管理", install_cmd: "npx -y @modelcontextprotocol/server-obsidian", stars: 2800 },
    HotEntry { slug: "spotify", name: "Spotify", description: "Spotify 音乐播放控制、播放列表和推荐发现", install_cmd: "npx -y @anthropic/mcp-server-spotify", stars: 2500 },
    HotEntry { slug: "calendar", name: "Google Calendar", description: "Google Calendar 日程创建、查询和提醒管理", install_cmd: "npx -y @anthropic/mcp-server-google-calendar", stars: 2300 },
    HotEntry { slug: "time", name: "World Time & Date", description: "全球时区时间查询、日期计算和定时任务", install_cmd: "npx -y @modelcontextprotocol/server-time", stars: 2000 },
];

/// 与 dev-api `mcp_market_search` 一致：空查询返回全部热门，否则按关键词过滤 slug/name/description
#[tauri::command]
pub fn mcp_market_search(query: Option<String>) -> Vec<Value> {
    let q = query.unwrap_or_default().trim().to_lowercase();
    HOT_MCP_SERVERS
        .iter()
        .filter(|e| {
            if q.is_empty() {
                return true;
            }
            e.slug.to_lowercase().contains(&q)
                || e.name.to_lowercase().contains(&q)
                || e.description.to_lowercase().contains(&q)
        })
        .map(|e| {
            json!({
                "slug": e.slug,
                "name": e.name,
                "description": e.description,
                "install_cmd": e.install_cmd,
                "stars": e.stars,
            })
        })
        .collect()
}
