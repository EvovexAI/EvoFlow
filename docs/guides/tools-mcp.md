# 工具与MCP配置指南
---
## 页面入口
点击左侧菜单栏「扩展」分类下的「工具管理」进入MCP服务器管理页面，包含两个Tab：「已安装」和「市场」。
---
## 管理已安装MCP服务器
进入「已安装」Tab可以查看所有已经配置的MCP服务器：
- 每个MCP卡片展示名称、类型（stdio/SSE/streamable-http）、功能描述、运行状态
- 卡片右上角的开关可以快速启用/禁用对应MCP，禁用后所有Agent都无法访问该MCP服务器
- 非系统内置的自定义MCP可以点击卡片右下角的删除按钮删除
- 顶部搜索框支持按MCP名称/描述过滤
- 右侧状态下拉可以筛选查看「全部」「已启用」「已禁用」MCP
- 点击「导入配置」按钮可以通过JSON格式批量导入MCP服务器配置
---
## 安装新MCP服务器
### 方式一：从MCP市场安装
1. 切换到「市场」Tab，自动加载热门公开MCP服务器
2. 可以在顶部搜索框输入关键词搜索需要的MCP
3. 找到需要的MCP后，点击卡片右下角的「安装」按钮，自动完成配置和启用
4. 安装完成后按钮变为「已安装 ✓」，可以在已安装Tab查看和管理
### 方式二：手动配置自定义MCP
1. 在「已安装」Tab点击页面右上角的「添加MCP」按钮
2. 选择MCP类型，填写对应配置：
   - **stdio类型（本地进程）**：
     - 命令：执行的命令（如npx、python等）
     - 参数：命令执行参数
     - 描述：功能说明
   - **SSE类型**：
     - URL：SSE服务地址
     - 描述：功能说明
   - **streamable-http类型**：
     - URL：HTTP流式服务地址
     - 描述：功能说明
3. 点击确认即可完成添加，MCP自动启用
---
## 给Agent配置MCP权限
安装后的MCP需要在Agent配置中启用才能使用：
1. 进入左侧「Agent管理」页面，编辑对应Agent
2. 切换到「MCP模块」Tab
3. 勾选需要让该Agent访问的MCP服务器，或者勾选「全部可用」使用所有已启用的MCP
4. 保存即可生效，后续该Agent对话时会根据需求自动调用对应MCP服务器的能力
---
## 常见MCP配置示例
### 1. 文件系统MCP（stdio类型）
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/working/directory"],
  "description": "本地文件系统访问能力"
}
```
### 2. 远程SSE服务MCP
```json
{
  "type": "sse",
  "url": "http://localhost:3000/sse",
  "description": "远程SSE服务能力"
}
```
### 3. 流式HTTP服务MCP
```json
{
  "type": "streamable-http",
  "url": "http://localhost:8080/mcp",
  "description": "远程HTTP流式服务能力"
}
```

