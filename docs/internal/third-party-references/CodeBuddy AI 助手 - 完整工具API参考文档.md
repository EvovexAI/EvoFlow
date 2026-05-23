# CodeBuddy AI 助手 - 完整工具API参考文档



## 📖 目录



1. [文件操作类工具](#1-文件操作类工具)

2. [搜索与内容查找工具](#2-搜索与内容查找工具)

3. [代码编辑工具](#3-代码编辑工具)

4. [命令执行工具](#4-命令执行工具)

5. [网络与搜索工具](#5-网络与搜索工具)

6. [团队协作工具](#6-团队协作工具)

7. [任务管理工具](#7-任务管理工具)

8. [自动化管理工具](#8-自动化管理工具)

9. [知识管理与RAG工具](#9-知识管理与rag工具)

10. [集成服务工具](#10-集成服务工具)

11. [技能加载工具](#11-技能加载工具)

12. [交互与辅助工具](#12-交互与辅助工具)

13. [运行时安装工具](#13-运行时安装工具)

14. [预览与网页工具](#14-预览与网页工具)

15. [Linter检查工具](#15-linter检查工具)




## 1. 文件操作类工具



### 1.1 `list_dir` - 列出目录内容



**功能描述**: 列出指定路径下的文件和目录，支持忽略特定模式的文件。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `target_directory` | string | **是** | - | 目标目录路径，可相对工作区根目录或绝对路径 |

| `ignore_globs` | string[] | 否 | [] | 可选的忽略模式数组，如 `["*.js", "**/node_modules/**"]` |



#### 入参示例



```json

{

  "target_directory": "d:/github/EvoFlow/backend",

  "ignore_globs": ["*.pyc", "__pycache__"]

}

```



```json

{

  "target_directory": "src/components",

  "ignore_globs": ["**/test/**", "*.spec.js"]

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 执行状态: `"success"` 或 `"error"` |

| result | object | 结果对象，包含目录列表信息 |



**成功响应示例**:

```json

{

  "status": "success",

  "result": {

    "type": "directory",

    "contents": [

      { "name": "app.py", "type": "file" },

      { "name": "models", "type": "directory" },

      { "name": "utils", "type": "directory" }

    ]

  }

}

```



**错误响应示例**:

```json

{

  "status": "error",

  "errorMessage": "ENOENT: no such file or directory"

}

```




### 1.2 `search_file` - 文件搜索（通配符）



**功能描述**: 支持通配符模式的递归文件搜索工具。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `pattern` | string | **是** | - | 文件匹配模式，如 `"*.js"`, `"test*.ts"` |

| `recursive` | boolean | **是** | - | 是否递归搜索子目录 |

| `target_directory` | string | 否 | 工作区根目录 | 搜索的目标绝对路径 |

| `caseSensitive` | boolean | 否 | false | 是否区分大小写 |



#### 入参示例



```json

{

  "pattern": "*.py",

  "recursive": true,

  "target_directory": "d:/github/EvoFlow/backend"

}

```



```json

{

  "pattern": "*_test.py",

  "recursive": true,

  "caseSensitive": true

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 执行状态 |

| result | string[] | 匹配的文件路径数组（相对路径） |



**响应示例**:

```json

{

  "status": "success",

  "result": [

    "backend/app/main.py",

    "backend/app/models/user.py",

    "backend/app/utils/helpers.py"

  ]

}

```




### 1.3 `read_file` - 读取文件内容



**功能描述**: 从本地文件系统读取文件，支持普通文本和图像文件（jpeg/jpg/png/gif/webp）。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `filePath` | string | **是** | - | **必须为绝对路径**的文件路径，不能是目录 |

| `offset` | number | 否 | - | 开始读取的行号（从1开始） |

| `limit` | number | 否 | - | 读取的行数限制 |



#### 入参示例



```json

{

  "filePath": "d:/github/EvoFlow/evopanel/src/pages/agents.js"

}

```



```json

{

  "filePath": "d:/github/EvoFlow/backend/app/gateway/app.py",

  "offset": 1,

  "limit": 100

}

```



```json

{

  "filePath": "d:/github/EvoFlow/screenshot.png"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 执行状态: `"success"` 或 `"error"` |

| result | string | 文件内容（带行号前缀）或图像数据 |

| linterErrors | array | 可选，IDE诊断信息（错误/警告/提示） |



**文本文件响应示例**:

```

     1:import React from 'react'

     2:import { useState, useEffect } from 'react'

     3:

     4:function App() {

     5:  return <div>Hello World</div>

     6:}

     7:

     8:export default App

```



**错误响应示例**:

```json

{

  "status": "error",

  "errorMessage": "File does not exist: d:/path/to/file.js"

}

```



> ⚠️ **注意**: 返回的内容每行以 `行号:` 格式前缀显示。使用时需要剥离此前缀。




### 1.4 `write_to_file` - 写入文件



**功能描述**: 将内容写入本地文件系统。如果文件已存在则覆盖。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `filePath` | string | **是** | - | **必须为绝对路径**，父目录不存在时会自动创建 |

| `content` | string | **是** | - | 要写入的内容（支持增量写入） |

| `explanation` | string | 否 | "" | 操作说明（用于日志记录） |



#### 入参示例



```json

{

  "filePath": "d:/github/EvoFlow/new-file.js",

  "content": "const greeting = 'Hello, World!';\nconsole.log(greeting);",

  "explanation": "创建新的问候语脚本"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | `"success"` 表示写入成功 |



**响应示例**:

```json

{

  "status": "success",

  "result": "Wrote contents to d:/github/EvoFlow/new-file.js"

}

```




### 1.5 `delete_file` - 删除文件



**功能描述**: 删除指定路径的文件。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `target_file` | string | **是** | - | 要删除文件的**绝对路径** |

| `explanation` | string | 否 | "" | 删除原因说明 |



#### 入参示例



```json

{

  "target_file": "d:/github/EvoFlow/temp/cache.tmp",

  "explanation": "清理临时缓存文件"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 执行状态 |



**响应示例**:

```json

{

  "status": "success",

  "result": "Deleted d:/github/EvoFlow/temp/cache.tmp"

}

```



**失败场景**: 文件不存在、权限不足、安全策略阻止




## 2. 搜索与内容查找工具



### 2.1 `search_content` - 内容搜索 (ripgrep)



**功能描述**: 基于ripgrep的强大搜索工具，支持正则表达式、文件类型过滤、上下文行等。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `pattern` | string | **是** | - | 正则表达式搜索模式 |

| `path` | string | 否 | 工作区根目录 | 搜索路径，**必须为绝对路径** |

| `outputMode` | string | 否 | `"content"` | 输出模式：`"content"`(匹配行) / `"files_with_matches"` / `"count"` |

| `glob` | string | 否 | - | 文件过滤模式，如 `"*.js"`, `"*.{ts,tsx}"` |

| `type` | string | 否 | - | 文件类型过滤: js, py, rust, go, java等 |

| `caseSensitive` | boolean | 否 | false | 区分大小写 |

| `multiline` | boolean | 否 | false | 多行模式 |

| `contextBefore` | number | 否 | - | 显示匹配前的行数（仅content模式） |

| `contextAfter` | number | 否 | - | 显示匹配后的行数（仅content模式） |

| `contextAround` | number | 否 | - | 显示匹配前后各N行（仅content模式） |

| `headLimit` | number | 否 | - | 限制返回结果数量 |

| `offset` | number | 否 | 0 | 跳过前N个结果（分页用） |



#### 入参示例



**基本搜索**:

```json

{

  "pattern": "function\\s+\\w+"

}

```



**带上下文和类型过滤**:

```json

{

  "pattern": "useState",

  "glob": "*.tsx",

  "contextAround": 3,

  "outputMode": "content"

}

```



**统计匹配次数**:

```json

{

  "pattern": "TODO|FIXME|HACK",

  "outputMode": "count",

  "type": "py"

}

```



**只找文件名**:

```json

{

  "pattern": "class.*Router",

  "path": "d:/github/EvoFlow/backend",

  "outputMode": "files_with_matches"

}

```



#### 出参 (Response)



**content模式输出**:

```

backend/app/gateway/routers/tasks.py:42:        async def create_task(self, request: Request):

backend/app/gateway/routers/agents.py:18:from fastapi import APIRouter

```



**files_with_matches模式输出**:

```json

[

  "backend/app/gateway/routers/tasks.py",

  "backend/app/gateway/routers/agents.py"

]

```



**count模式输出**:

```json

[

  {"path": "backend/app/main.py", "count": 5},

  {"path": "backend/utils/helpers.py", "count": 2}

]

```




## 3. 代码编辑工具



### 3.1 `replace_in_file` - 字符串替换编辑



**功能描述**: 在现有文件中执行精确字符串替换。**优先使用此工具修改已有文件**。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `filePath` | string | **是** | - | 目标文件**绝对路径** |

| `old_str` | string | **是** | - | 要替换的原始文本（必须完全匹配，含缩进空格和换行） |

| `new_str` | string | **是** | - | 替换后的新文本 |

| `explanation` | string | 否 | "" | 编辑说明（中文） |



#### 入参示例



**替换单行**:

```json

{

  "filePath": "d:/github/EvoFlow/evopanel/src/pages/agents.js",

  "old_str": "const apiUrl = 'http://localhost:8080';",

  "new_str": "const apiUrl = 'https://api.production.com';",

  "explanation": "更新API地址为生产环境"

}

```



**替换多行代码块**:

```json

{

  "filePath": "d:/github/EvoFlow/backend/app/main.py",

  "old_str": "@app.get('/health')\ndef health_check():\n    return {'status': 'ok'}",

  "new_str": "@app.get('/health')\nasync def health_check():\n    return {'status': 'ok', 'timestamp': time.time()}",

  "explanation": "将健康检查改为异步并添加时间戳"

}

```



**删除代码块**（new_str设为空）:

```json

{

  "filePath": "d:/github/EvoFlow/test.py",

  "old_str": "# Debug logging\nprint('Debug info')\n",

  "new_str": "",

  "explanation": "移除调试日志"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | `"success"` 或 `"error"` |



**成功响应**:

```json

{

  "status": "success",

  "result": "Replaced in d:/github/EvoFlow/backend/app/main.py"

}

```



**失败响应**:

```json

{

  "status": "error",

  "errorMessage": "old_str is not unique in the file"

}

```



> ⚠️ **关键注意事项**:

> - `old_str` **必须唯一**，否则编辑会失败

> - 如果不唯一，提供更大的上下文范围使其唯一

> - 行号前缀（如 `    42:`）**不能**包含在 old_str 中

> - 保留原文的所有标点符号（包括中文引号）

> - 在最近5条消息内未读过的文件，编辑前必须先 read_file




## 4. 命令执行工具



### 4.1 `execute_command` - 执行系统命令



**功能描述**: 在用户操作系统上执行命令行指令。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `command` | string | **是** | - | 要执行的CLI命令 |

| `requires_approval` | boolean | **是** | - | 是否需要用户批准 |

| `explanation` | string | 否 | "" | 命令说明（中文） |



#### 入参示例



**安全操作（无需批准）**:

```json

{

  "command": "npm run build",

  "requires_approval": false,

  "explanation": "构建前端项目"

}

```



```json

{

  "command": "git --no-pager log --oneline -5",

  "requires_approval": false,

  "explanation": "查看最近5条提交记录"

}

```



**危险操作（需批准）**:

```json

{

  "command": "rm -rf node_modules",

  "requires_approval": true,

  "explanation": "删除node_modules目录"

}

```



```json

{

  "command": "git push --force origin main",

  "requires_approval": true,

  "explanation": "强制推送到main分支"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | `"success"` / `"skipped"` / `"error"` |

| result | object | 包含 stdout 和 stderr 的结果对象 |



**成功响应**:

```json

{

  "status": "success",

  "result": {

    "stdout": "Build completed successfully.\nOutput: dist/bundle.js\n",

    "stderr": "",

    "exitCode": 0

  }

}

```



**被跳过（用户取消或超时）**:

```json

{

  "status": "skipped",

  "errorMessage": "Execution skipped: user cancelled"

}

```



> ⚠️ **使用规范**:

> - 新Shell默认初始化在工作项目根目录

> - 非交互式命令自动传递标志（如 `--yes`）

> - 使用分页器禁用：`git --no-pager log` 或 `| cat`

> - 不在命令中包含换行符

> - 工作区外操作需要设置 `requires_approval: true`

> - 遵循Git安全协议




## 5. 网络与搜索工具



### 5.1 `web_search` - 网络搜索



**功能描述**: 获取实时网络信息的搜索引擎工具。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `query` | string | **是** | - | 搜索关键词 |

| `explanation` | string | **是** | - | 搜索目的说明 |

| `max_results` | number | 否 | - | 最大返回结果数 |

| `language` | string | 否 | auto | 语言代码，如 `"zh-CN"`, `"en-US"` |



#### 入参示例



```json

{

  "query": "React 19 new features 2025",

  "explanation": "查询React 19的新特性",

  "max_results": 10,

  "language": "en-US"

}

```



```json

{

  "query": "AI大模型 最新进展 2026年4月",

  "explanation": "搜索本月AI大模型动态",

  "language": "zh-CN"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| results | array[] | 搜索结果数组，每个元素包含标题、摘要、URL等 |



**响应示例**:

```json

{

  "results": [

    {

      "title": "React 19正式发布 - 完整更新指南",

      "url": "https://react.dev/blog/react-19",

      "snippet": "React 19带来了全新的Server Components、Actions和use() Hook...",

      "date": "2025-12-15"

    },

    {

      "title": "React 19迁移最佳实践",

      "url": "https://example.com/react19-migration",

      "snippet": "本文详细介绍如何从React 18平滑升级到React 19..."

    }

  ]

}

```




### 5.2 `web_fetch` - 抓取网页内容



**功能描述**: 获取指定URL的内容并转换为Markdown格式，由AI模型处理分析。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `url` | string | **是** | - | 完整有效的HTTP/HTTPS URL |

| `fetchInfo` | string | **是** | - | 说明要从页面提取什么信息 |



#### 入参示例



```json

{

  "url": "https://www.codebuddy.ai/docs/zh/ide/User-guide/Overview",

  "fetchInfo": "提取CodeBuddy的主要功能和特性列表"

}

```



```json

{

  "url": "https://github.com/torvalds/linux/blob/master/README",

  "fetchInfo": "获取Linux内核README的关键配置说明"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| content | string | 网页内容的Markdown转换和分析结果 |

| redirectUrl | string | 如有重定向，返回重定向URL |



**响应示例**:

```

# CodeBuddy 用户指南概述



## 主要功能

1. **智能编码助手** - 基于GLM模型的AI编程...

2. **自动化任务** - 支持定时和一次性任务...

3. **多代理协作** - Team mode支持并行处理...



（注：大内容会被AI总结）

```




## 6. 团队协作工具



### 6.1 `task` - 启动子代理



**功能描述**: 启动专门的子代理来处理复杂的多步骤任务。支持同步模式和异步团队模式。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `subagent_name` | string | **是** | - | 子代理名称（必须匹配可用名称） |

| `description` | string | **是** | - | 任务简短描述（3-5词） |

| `prompt` | string | **是** | - | 子代理要完成的详细任务描述 |

| `name` | string | 否 | - | 团队成员名称（触发团队模式） |

| `team_name` | string | 否 | - | 加入或创建的团队名称 |

| `mode` | string | 否 | `"default"` | 权限模式: `"acceptEdits"`, `"bypassPermissions"`, `"default"`, `"plan"` |

| `max_turns` | number | 否 | - | 代理最大轮次数限制 |



#### 入参示例



**同步模式（code-explorer探索）**:

```json

{

  "subagent_name": "code-explorer",

  "description": "探索后端路由结构",

  "prompt": "请全面分析 d:/github/EvoFlow/backend/app/gateway/routers 目录下的所有路由文件，找出每个路由的功能、端点和依赖关系"

}

```



**团队模式（异步）**:

```json

{

  "subagent_name": "code-explorer",

  "description": "分析前端组件依赖",

  "prompt": "分析 evopanel/src/pages 下所有页面的组件导入关系",

  "name": "frontend-analyzer",

  "team_name": "refactor-team",

  "mode": "bypassPermissions",

  "max_turns": 20

}

```



#### 出参 (Response)



**同步模式返回**:

```json

{

  "status": "completed",

  "summary": "完成对routers目录的分析...",

  "details": {

    "filesAnalyzed": 5,

    "routesFound": [

      "/api/agents", "/api/tasks", "/api/threads"

    ]

  }

}

```



**团队模式返回**（立即返回）:

```json

{

  "status": "spawned",

  "agentName": "frontend-analyzer",

  "teamName": "refactor-team",

  "message": "Agent started in background"

}

```



> 💡 **何时使用Task工具**:

> - ✅ 跨多文件/目录的大规模搜索

> - ✅ 代码库结构理解

> - ✅ 复杂任务的并行处理

> - ❌ 读取单个已知文件

> - ❌ 单个函数的简单搜索




### 6.2 `team_create` - 创建团队



**功能描述**: 创建新的协调多代理工作的团队。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `team_name` | string | **是** | - | 团队名称（小写+连字符，如 `"feature-alpha"`） |

| `description` | string | 否 | "" | 团队目标和用途描述 |



#### 入参示例



```json

{

  "team_name": "feature-auth-refactor",

  "description": "认证模块重构团队，负责前后端认证逻辑的改造"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 创建状态 |

| teamPath | string | 团队数据存储路径 |



**响应示例**:

```json

{

  "status": "created",

  "teamPath": ".codebuddy/teams/feature-auth-refactor/",

  "message": "Team created successfully"

}

```




### 6.3 `team_delete` - 删除团队



**功能描述**: 删除当前团队并清理所有团队资源。



#### 入参 (Request Parameters)



无参数（操作作用于当前活跃团队）



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 删除状态 |



**前置条件**: 所有团队成员必须处于idle或completed状态




### 6.4 `send_message` - 团队消息通信



**功能描述**: 在团队成员之间发送消息，支持多种消息类型。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `type` | string | **是** | - | 消息类型 |

| `recipient` | string | 条件必填 | - | 接收者（message/shutdown_request/plan_approval_response必需） |

| `content` | string | 条件必填 | - | 消息内容 |

| `summary` | string | 条件必填 | - | 5-10词的消息摘要（message/broadcast必需） |

| `request_id` | string | 条件必填 | - | 请求ID（shutdown_response/plan_approval_response必需） |

| `approve` | boolean | 条件必填 | - | 是否批准（shutdown_response/plan_approval_response必需） |



**消息类型详解**:



| type | 用途 | 必需参数 |

|------|------|----------|

| `message` | 发送消息给指定成员 | recipient, content, summary |

| `broadcast` | 广播给所有成员 | content, summary |

| `shutdown_request` | 请求关闭成员 | recipient, content |

| `shutdown_response` | 回应关闭请求 | request_id, approve |

| `plan_approval_response` | 回应计划审批 | recipient, request_id, approve |



#### 入参示例



**发送消息**:

```json

{

  "type": "message",

  "recipient": "alice",

  "content": "请审查PR #42的变更，重点关注数据库迁移部分",

  "summary": "请求PR审查"

}

```



**广播消息**:

```json

{

  "type": "broadcast",

  "content": "全体会议将在5分钟后开始",

  "summary": "会议通知"

}

```



**请求关闭**:

```json

{

  "type": "shutdown_request",

  "recipient": "bob",

  "content": "所有任务已完成，请关闭"

}

```



**批准关闭**:

```json

{

  "type": "shutdown_response",

  "request_id": "req-001",

  "approve": true

}

```



#### 出参 (Response)



```json

{

  "status": "sent",

  "messageId": "msg-123456",

  "deliveredTo": ["alice"]

}

```




## 7. 任务管理工具



### 7.1 `todo_write` - 待办事项管理



**功能描述**: 创建和管理结构化的待办事项列表，跟踪复杂任务的进度。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `todos` | string(JSON) | **是** | - | JSON格式的待办事项数组 |

| `merge` | boolean | **是** | - | `true`=合并到现有列表, `false`=替换全部 |



**todos JSON格式**:

```json

[{

  "id": "string",           // 唯一标识符

  "status": "string",       // pending | in_progress | completed | cancelled

  "content": "string"       // 任务描述（面向用户的完整功能模块）

}]

```



#### 入参示例



**首次创建**:

```json

{

  "merge": false,

  "todos": "[{\"id\":\"1\",\"status\":\"in_progress\",\"content\":\"设计数据库Schema\"},{\"id\":\"2\",\"status\":\"pending\",\"content\":\"实现用户认证API\"},{\"id\":\"3\",\"status\":\"pending\",\"content\":\"编写单元测试\"}]"

}

```



**合并更新（开始新任务+完成旧任务）**:

```json

{

  "merge": true,

  "todos": "[{\"id\":\"1\",\"status\":\"completed\",\"content\":\"设计数据库Schema\"},{\"id\":\"2\",\"status\":\"in_progress\",\"content\":\"实现用户认证API\"},{\"id\":\"3\",\"status\":\"pending\",\"content\":\"编写单元测试\"}]"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| status | string | 更新状态 |

| todos | array[] | 当前的完整待办列表 |



**响应示例**:

```json

{

  "status": "updated",

  "todos": [

    { "id": "1", "status": "completed", "content": "设计数据库Schema" },

    { "id": "2", "status": "in_progress", "content": "实现用户认证API" },

    { "id": "3", "status": "pending", "content": "编写单元测试" }

  ]

}

```



> ⚠️ **使用原则**:

> - 待办项应为面向用户的**完整功能模块**，避免过于细粒度

> - 理想情况下不超过7项

> - 开始任务时立即标记 `in_progress`，完成后立即标记 `completed`

> - 不要将linting/testing/codebase搜索作为独立todo




## 8. 自动化管理工具



### 8.1 `automation_update` - 自动化任务CRUD



**功能描述**: 管理 IDE 自动化任务，支持查看、创建、更新定时和一次性任务。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `mode` | string | **是** | - | `"view"` / `"suggested create"` / `"suggested update"` |

| `id` | string | 条件必填 | - | 任务ID（view和update模式必需） |

| `name` | string | 条件必填 | - | 任务名称（create/update必需） |

| `prompt` | string | 条件必填 | - | 任务指令（create/update必需） |

| `cwds` | string | 条件必填 | - | 工作目录JSON数组或逗号分隔（create/update必需） |

| `status` | string | 条件必填 | - | `"ACTIVE"` 或 `"PAUSED"`（create/update必需） |

| `scheduleType` | string | 否 | `"recurring"` | `"recurring"`（周期性）/ `"once"`（一次性） |

| `rrule` | string | 条件必填 | - | iCalendar RRULE规则（recurring必需） |

| `scheduledAt` | string | 条件必填 | - | ISO 8601时间（once必需） |

| `maxDurationMinutes` | number | 否 | - | 任务最大执行时长限制 |

| `validFrom` | string | 否 | - | 有效期开始日期 |

| `validUntil` | string | 否 | - | 有效期结束日期 |



**RRULE常用规则**:



| 规则 | 含义 |

|------|------|

| `FREQ=HOURLY;INTERVAL=1` | 每1小时 |

| `FREQ=HOURLY;INTERVAL=2` | 每2小时 |

| `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` | 每天09:00 |

| `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9` | 周一三五09:00 |



#### 入参示例



**查看现有任务**:

```json

{

  "mode": "view",

  "id": "abc123def456"

}

```



**创建每日定时任务**:

```json

{

  "mode": "suggested create",

  "name": "每日AI新闻聚合",

  "prompt": "搜索今日AI领域的重大新闻，包括大模型发布、技术突破、行业动态，整理成Markdown报告保存到 /mnt/user-data/outputs/ 目录",

  "cwds": "[\"d:/github/EvoFlow\"]",

  "status": "ACTIVE",

  "scheduleType": "recurring",

  "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",

  "validFrom": "2026-04-10",

  "validUntil": "2026-12-31"

}

```



**创建一次性提醒**:

```json

{

  "mode": "suggested create",

  "name": "周五会议提醒",

  "prompt": "提醒用户参加下午3点的产品评审会议",

  "cwds": "d:/github/EvoFlow",

  "status": "ACTIVE",

  "scheduleType": "once",

  "scheduledAt": "2026-04-10T15:00"

}

```



**更新现有任务**:

```json

{

  "mode": "suggested update",

  "id": "300f9c6a",

  "name": "每日AI新闻搜索与增强版",

  "rrule": "FREQ=DAILY;BYHOUR=8;BYMINUTE=30"

}

```



#### 出参 (Response)



**view模式**:

```json

{

  "id": "300f9c6a",

  "name": "每日AI新闻聚合",

  "status": "ACTIVE",

  "scheduleType": "recurring",

  "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",

  "prompt": "搜索今日AI领域重大新闻...",

  "cwds": ["d:/github/EvoFlow"],

  "lastRunAt": "2026-04-10T09:00:00Z",

  "nextRunAt": "2026-04-11T09:00:00Z"

}

```



**create模式**:

```json

{

  "status": "created",

  "id": "new-automation-id",

  "message": "Automation created successfully"

}

```




## 9. 知识管理与RAG工具



### 9.1 `update_memory` - 知识库记忆管理



**功能描述**: 在持久化知识库中创建、更新或删除记忆。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `action` | string | 否 | `"create"` | `"create"` / `"update"` / `"delete"` |

| `title` | string | 条件必填 | - | 记忆标题（create/update必需） |

| `knowledge_to_store` | string | 条件必填 | - | 存储的内容段落（不超过一段话）（create/update必需） |

| `existing_knowledge_id` | string | 条件必填 | - | 已有记忆ID（update/delete必需） |



#### 入参示例



**创建记忆**:

```json

{

  "action": "create",

  "title": "项目数据库选择偏好",

  "knowledge_to_store": "EvoFlow项目的数据库层首选PostgreSQL，通过Supabase托管，备用方案为CloudBase云数据库。ORM使用SQLAlchemy 2.0版本。"

}

```



**更新记忆**:

```json

{

  "action": "update",

  "existing_knowledge_id": "mem-abc123",

  "title": "项目数据库选择偏好（已更新）",

  "knowledge_to_store": "EvoFlow项目主数据库改为MySQL 8.0，通过CloudBase托管。PostgreSQL降级为数据分析库。ORM仍使用SQLAlchemy 2.0。"

}

```



**删除记忆（矛盾信息时）**:

```json

{

  "action": "delete",

  "existing_knowledge_id": "mem-abc123"

}

```



#### 出参 (Response)



**创建成功**:

```json

{

  "action": "created",

  "memoryId": "mem-new-id-456",

  "title": "项目数据库选择偏好",

  "timestamp": "2026-04-10T10:23:00Z"

}

```



**更新成功**:

```json

{

  "action": "updated",

  "memoryId": "mem-abc123",

  "title": "项目数据库选择偏好（已更新）"

}

```




### 9.2 `RAG_search` - 知识库检索



**功能描述**: 从连接的知识库中获取最新的专业信息。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `queryString` | string | **是** | - | 用户的具体问题或搜索查询 |

| `knowledgeBaseNames` | string | **是** | - | 知识库名称（逗号分隔多个） |



**可用知识库列表**: `腾讯云API`, `微信云开发`, `腾讯云实时音视频`, `TDesign`, `微信支付`, `微信小程序`, `微信小游戏`, `腾讯地图小程序`



#### 入参示例



```json

{

  "queryString": "微信小程序云开发如何初始化数据库连接？",

  "knowledgeBaseNames": "微信云开发,微信小程序"

}

```



```json

{

  "queryString": "TDesign组件库如何在React项目中按需引入？",

  "knowledgeBaseNames": "TDesign"

}

```



#### 出参 (Response)



| 字段 | 类型 | 描述 |

|------|------|------|

| results | array[] | 来自知识库的相关文档片段 |

| sources | string[] | 来源知识库名称 |



**响应示例**:

```json

{

  "results": [

    {

      "content": "微信小程序云开发初始化步骤：1. 在app.js中调用 wx.cloud.init({...}) 2. env参数指定环境ID...",

      "source": "微信云开发",

      "relevanceScore": 0.95

    },

    {

      "content": "数据库初始化示例代码：const db = wx.cloud.database()...",

      "source": "微信小程序",

      "relevanceScore": 0.88

    }

  ],

  "sources": ["微信云开发", "微信小程序"]

}

```




## 10. 集成服务工具



### 10.1 `invoke_integration` - 调用集成服务



**功能描述**: 连接和使用集成服务（数据库、部署等）的正确方式。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `id` | string | **是** | - | 集成服务ID |

| `type` | string | **是** | - | 服务类型: `"deploy"` 或 `"database"` |



**可用集成服务**:



| id | name | types |

|----|------|-------|

| tcb | CloudBase | deploy, database |

| eop | EdgeOne Pages | deploy |

| supabase | Supabase | database |

| cloudstudio | Cloud Studio | deploy |

| lighthouse | Tencent Lighthouse | deploy |



#### 入参示例



**连接数据库服务**:

```json

{

  "id": "supabase",

  "type": "database"

}

```



**部署应用**:

```json

{

  "id": "vercel-deploy",

  "type": "deploy"

}

```



#### 出参 (Response)



**未连接时**:

```json

{

  "status": "connection_required",

  "message": "请在Integration UI中登录并授权Supabase",

  "authUrl": "/integrations/supabase/auth"

}

```



**已连接时**:

```json

{

  "status": "connected",

  "service": {

    "id": "supabase",

    "name": "Supabase",

    "capabilities": ["database", "storage", "auth", "realtime"],

    "projectUrl": "https://xyz.supabase.co"

  }

}

```




## 11. 技能加载工具



### 11.1 `use_skill` - 加载技能扩展包



**功能描述**: 加载领域特定的技能（Skill），获得专业知识和工作流指导。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `command` | string | **是** | - | 技能名称（不含参数） |



**部分可用技能列表**:



| 技能名称 | 适用场景 |

|----------|----------|

| `pdf` | PDF文件任何操作 |

| `docx` | Word文档创建/读写/编辑 |

| `xlsx` | 电子表格处理与分析 |

| `pptx` | PowerPoint演示文稿操作 |

| `deep-research` | 深度研究 + 旗舰洞察页（HTML）生成（含数据、图表、风险热度、变化信号与动效模板） |

| `frontend-design` | Web UI界面设计与美化 |

| `image-generation` | AI图像生成 |

| `video-generation` | AI视频生成 |

| `data-analysis` | Excel/CSV数据分析 |

| `browser` | 浏览器自动化 |

| `playwright-cli` | Playwright浏览器测试 |

| `chart-visualization` | 数据可视化图表 |

| `consulting-analysis` | 专业研究报告生成 |

| `skill-creator` | 创建/修改技能 |

| `exec_command` | 系统命令执行 |

| `file_operations` | 文件读写编辑操作 |



#### 入参示例



```json

{

  "command": "pdf"

}

```



```json

{

  "command": "deep-research"

}

```



```json

{

  "command": "frontend-design"

}

```



#### 出参 (Response)



**加载成功**:

```json

{

  "status": "loaded",

  "skillName": "pdf",

  "description": "PDF文件处理技能已加载，支持：读取、合并、拆分、旋转、水印、加密、OCR等功能。",

  "availableTools": ["pdf_read", "pdf_merge", "pdf_split", "pdf_rotate", "pdf_add_watermark", "pdf_encrypt", "pdf_decrypt", "pdf_extract_images", "pdf_ocr"],

  "instructions": "完整的PDF处理工作流指南已注入上下文..."

}

```



> 💡 **使用时机判断**:

> - ✅ 请求涉及特定域（如"帮我做个PPT"、"分析这个Excel"）

> - ✅ 相关技能存在且能提升效率/正确性

> - ✅ 用户明确提到相关关键词

> - ❌ 可以用通用推理解决的任务

> - ❌ 不存在的技能

> - ❌ 技能已在当前上下文中加载




## 12. 交互与辅助工具



### 12.1 `ask_followup_question` - 结构化问答收集



**功能描述**: 向用户收集结构化化的多选项答案，用于需求澄清。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `questions` | string(JSON) | **是** | - | 问题数组JSON（1-4个问题） |

| `title` | string | 否 | - | 表单可选标题 |



**questions JSON格式**:

```json

[{

  "id": "string",          // 问题标识

  "question": "string",    // 问题文本

  "options": "string[]",   // 选项数组

  "multiSelect": boolean   // 是否多选（默认false）

}]

```



#### 入参示例



```json

{

  "title": "项目技术栈选择",

  "questions": "[{\"id\":\"q1\",\"question\":\"前端框架选择哪个？\",\"options\":[\"React\",\"Vue\",\"Angular\",\"Svelte\"],\"multiSelect\":false},{\"id\":\"q2\",\"question\":\"需要哪些额外功能？（可多选）\",\"options\":[\"暗色主题\",\"国际化\",\"SSR\",\"PWA\"],\"multiSelect\":true}]"

}

```



#### 出参 (Response)



```json

{

  "answers": {

    "q1": { "selected": "React", "question": "前端框架选择哪个？" },

    "q2": { "selected": ["暗色主题", "PWA"], "question": "需要哪些额外功能？" }

  }

}

```



> ⚠️ **使用原则**: 仅在高度不确定且必须澄清时使用，优先尝试推理和其他工具解决。




### 12.2 `read_lints` - Linter错误读取



**功能描述**: 读取工作区的IDE诊断/linter错误信息。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `paths` | string | 否 | 全部文件 | 特定文件或目录的linter错误 |



#### 入参示例



```json

{

  "paths": "d:/github/EvoFlow/evopanel/src/pages/agents.js"

}

```



```json

{

  "paths": "d:/github/EvoFlow/evopanel/src"

}

```



#### 出参 (Response)



```json

{

  "errors": [

    {

      "file": "evopanel/src/pages/agents.js",

      "line": 121,

      "column": 15,

      "severity": "error",

      "message": "'useState' is not defined no-undef",

      "rule": "no-undef"

    },

    {

      "file": "evopanel/src/pages/agents.js",

      "line": 205,

      "column": 8,

      "severity": "warning",

      "message": "Unused variable 'tempData' no-unused-vars",

      "rule": "no-unused-vars"

    }

  ],

  "totalErrors": 1,

  "totalWarnings": 1

}

```




## 13. 运行时安装工具



### 13.1 `install_binary` - 安装运行时



**功能描述**: 安装指定版本的Python或Node.js运行时二进制文件。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `type` | string | **是** | - | 运行时类型: `"python"` 或 `"node"` |

| `version` | string | **是** | - | 具体版本号，如 `"3.12.0"`, `"20.19.0"` |



#### 入参示例



```json

{

  "type": "python",

  "version": "3.12.0"

}

```



```json

{

  "type": "node",

  "version": "22.0.0"

}

```



#### 出参 (Response)



**安装成功**:

```json

{

  "status": "installed",

  "type": "python",

  "version": "3.12.0",

  "path": "C:\\Users\\.codebuddy\\runtimes\\python-3.12.0\\python.exe",

  "message": "Python 3.12.0 installed successfully"

}

```



**已存在兼容版本**:

```json

{

  "status": "reuse",

  "message": "Python 3.12.0 already installed, reusing existing installation"

}

```




## 14. 预览与网页工具



### 14.1 `preview_url` - URL预览



**功能描述**: 在IDE内置浏览器中预览HTTP/HTTPS URL。



#### 入参 (Request Parameters)



| 参数名 | 类型 | 必填 | 默认值 | 描述 |

|--------|------|------|--------|------|

| `url` | string | **是** | - | 完整有效的HTTP/HTTPS URL |

| `explanation` | string | 否 | "" | 预览原因说明 |



#### 入参示例



```json

{

  "url": "http://localhost:3000",

  "explanation": "预览本地开发服务器"

}

```



```json

{

  "url": "https://example-deploy.vercel.app",

  "explanation": "预览Vercel部署的应用"

}

```



#### 出参 (Response)



```json

{

  "status": "previewing",

  "url": "http://localhost:3000",

  "browserTabId": "tab-preview-001"

}

```



> ⚠️ **注意**: 仅接受HTTP/HTTPS URL，不支持本地文件路径或 `file://` 协议。如果有运行中的dev/server，使用其HTTP URL。




## 附录A: 工具快速索引表



| 分类 | 工具名 | 核心功能 | 参数复杂度 |

|------|--------|----------|-----------|

| **文件操作** | `list_dir` | 列出目录 | ⭐ |

| **文件操作** | `search_file` | 通配符搜文件 | ⭐⭐ |

| **文件操作** | `read_file` | 读取文件 | ⭐⭐ |

| **文件操作** | `write_to_file` | 写入/创建文件 | ⭐⭐ |

| **文件操作** | `delete_file` | 删除文件 | ⭐ |

| **内容搜索** | `search_content` | ripgrep搜索 | ⭐⭐⭐ |

| **代码编辑** | `replace_in_file` | 字符串替换 | ⭐⭐⭐ |

| **命令执行** | `execute_command` | 系统命令 | ⭐⭐⭐ |

| **网络搜索** | `web_search` | 网络搜索 | ⭐⭐ |

| **网页抓取** | `web_fetch` | 网页转MD | ⭐⭐ |

| **子代理** | `task` | 启动子代理 | ⭐⭐⭐ |

| **团队** | `team_create` | 创建团队 | ⭐ |

| **团队** | `team_delete` | 删除团队 | ⭐ |

| **团队** | `send_message` | 团队通信 | ⭐⭐⭐ |

| **任务管理** | `todo_write` | 待办事项 | ⭐⭐ |

| **自动化** | `automation_update` | 定时任务 | ⭐⭐⭐⭐ |

| **记忆** | `update_memory` | 知识库CRUD | ⭐⭐ |

| **RAG** | `RAG_search` | 知识库检索 | ⭐⭐ |

| **集成** | `invoke_integration` | 服务连接 | ⭐⭐ |

| **技能** | `use_skill` | 加载技能 | ⭐ |

| **问答** | `ask_followup_question` | 收集答案 | ⭐⭐ |

| **Linter** | `read_lints` | 错误检查 | ⭐ |

| **安装** | `install_binary` | 运行时安装 | ⭐⭐ |

| **预览** | `preview_url` | 浏览器预览 | ⭐⭐ |




## 附录B: 常见使用模式



### 模式1: 修改代码的标准流程



```

步骤1: read_file(filePath)           → 了解文件现状

步骤2: read_lints(paths)             → 检查现有linter错误  

步骤3: replace_in_file(...)          → 执行精准编辑

步骤4: read_lints(paths)             → 验证无新增错误

```



### 模式2: 大规模代码探索



```

步骤1: task(subagent_name="code-explorer") → 启动探索子代理

步骤2: 接收分析结果                        → 获得结构化报告

```



### 模式3: 并行信息收集



```

同时调用:

├── read_file("config.json")

├── search_content("pattern=A")

├── search_content("pattern=B")

├── list_dir("src/")

└── web_search("query=C")

→ 一次性获得所有上下文

```



### 模式4: 自动化工作流



```

步骤1: automation_update(mode="suggested create") → 创建定时任务

步骤2: 定义rrule/cwds/prompt/status                → 配置执行规则

步骤3: automation_update(mode="view")              → 监控执行状态

```




*本文档由CodeBuddy AI助手自动生成*  

*最后更新: 2026-04-10 10:23*
