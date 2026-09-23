# 个人思想库 Thought Library · 架构与实现详解

本文档对「个人思想库」的整体架构、模块划分、核心算法与数据流进行系统性梳理。

---

## 1. 项目定位

一个运行在**你自己电脑上**的本地 AI 知识库网站：把你坚持的原则、决策逻辑、知识与经验**分仓库存入**，提问时**只从指定仓库检索**，再调用 AI **优先按你的原则和逻辑**作答，最后以你的视角输出。核心价值是「让 AI 学会用你的方式思考」。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Node.js 本地服务器                        │
│                   （纯 http/fs/path/crypto/zlib，零依赖）     │
│  ┌───────────────┬───────────────┬───────────────────────┐  │
│  │ 路由/HTTP层    │ 业务核心       │ AI 接入层             │  │
│  │ serveStatic   │ retrieveThoughts│ buildSystemPrompt    │  │
│  │ /api/* handler│ tokenize+score │ callAIStream (SSE)    │  │
│  │               │ 文档导入(unzip/│ judgeStudyAnswer      │  │
│  │               │  docx/txt)     │ buildMockAnswer(演示) │  │
│  └───────┬───────┴───────┬───────┴───────────┬───────────┘  │
│          │               │                   │              │
│  ┌───────▼─────────┐ ┌───▼──────────────┐ ┌──▼────────────┐ │
│  │ public/ 前端 SPA │ │ data/*.json 存储 │ │ study.js 记忆 │ │
│  │ app.js + index  │ │ 思想/仓库/对话/学习│ │ 调度算法      │ │
│  └─────────────────┘ └──────────────────┘ └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**零依赖原则**：不用 Express、不用数据库，仅用 Node 内置模块实现 HTTP 服务器、静态服务、流式响应与 JSON 文件存储。数据与代码全在项目目录，监听 `127.0.0.1` 仅供本机访问。

## 3. 模块划分

### 3.1 服务端 `server.js`（1351 行）

| 分层 | 关键函数 | 职责 |
| --- | --- | --- |
| 存储层 | `readJson` / `writeJsonAtomic`、`loadThoughts` / `saveThoughts`、`loadConversations` / `saveConversations`、`loadRepos` / `saveRepos`、`loadStudy` / `saveStudy`、`loadConfig` / `saveConfig` | 以 JSON 文件读写全部数据（原子写防损坏）；`ensureDir` 建目录；`migrate` 数据迁移 |
| 检索层 | `tokenize`、`scoreThought`、`retrieveThoughts`、`formatThoughts` | 中文分词 + 相关性评分，从所选仓库检索最相关思想 |
| AI 层 | `buildSystemPrompt`、`callAIStream`、`sse`、`buildMockAnswer`、`handleTestAI`、`judgeStudyAnswer` | 构造提示词、流式调用 OpenAI 兼容接口、演示模式、连接测试、学习判分 |
| 文档导入 | `unzip`、`extractDocx`、`extractTextFromBuffer`、`decodeText`、`cleanText`、`capText`、`handleImportDoc` | 解析 txt / Word / zip，自动识别 UTF-8 / GBK |
| 学习模式 | `buildStudyPrompt`、`handleStudyAsk`、`studyForRepo`、`studyOverview` | 结合 `study.js` 做主动回忆训练 |
| HTTP 路由 | `serveStatic`、`handleAsk`、`handleImportDoc`、`handleStudyAsk`、`sendJson`、`readBody` | 静态资源 + `/api/*` REST 接口 |

### 3.2 记忆调度 `study.js`（138 行）

纯函数模块，实现学习/复习的**间隔调度与存活率**算法：

- `emptyState` / `loadOrInitState`：学习状态初始化；
- `applyVerdict`：根据作答对错更新知识点存活率（答对 +20，答错 -30）；
- `isDue` / `addDaysIso` / `addHoursIso`：到期判断与时间推进（已掌握每 3 天复习，薄弱每 1 小时复习）；
- `pickStudyPoint`：按优先级挑选待复习知识点（未掌握 > 已到期 > 从未学过 > 薄弱 > 存活率低）。

### 3.3 前端 `public/app.js`（1198 行）

SPA 单页，四大功能区：

| 功能区 | 关键函数 | 职责 |
| --- | --- | --- |
| 思想库 | `renderThoughts`、`saveThought`、`deleteThought`、`renderRepoBar`、`saveRepo`、`deleteRepo`、`handleImportDoc` | 多仓库思想 CRUD、文档导入、分类管理 |
| 智能问答 | `ask`、`pushMessage`、`renderChat`、`persistConversation`、`loadConversation`、`learnFromChat` | 选仓库提问、流式渲染、对话历史、一键存入思想库 |
| 学习模式 | `studyStart`、`studySubmit`、`studySend`、`studyResetPoint`、`renderStudyList`、`renderStudyMessages` | 主动回忆四阶段循环、存活率面板 |
| 设置/备份 | `saveSettings`、`testAI`、`doExport`、`doImport`、`clearAll` | AI 配置、数据导出/导入备份 |

## 4. 核心：本地检索算法（如何"学会你的逻辑"）

每次提问时，服务器执行四步（`handleAsk`）：

```
1. retrieveThoughts(query, config, repoIds)
     在【所选仓库】内：tokenize(query) 中文分词
     对每条思想：scoreThought() 对 标题/内容/标签/分类 分别打分
     决策类问题 → 优先加权「决策逻辑/原则」分类；重要思想额外加权
     取 topK 条（可配置 1~20）

2. buildSystemPrompt(config, thoughts, repoIds)
     把检索到的思想注入系统提示词，作为回答的【第一依据】
     明确本次检索范围，注入 userName 与自定义 systemPrompt

3. callAIStream(messages, config, onDelta)
     fetch 兼容接口 POST /chat/completions，SSE 流式回传（sse()）

4. 输出【思考路径】+ 参考来源
     回答末尾说明调用了哪些仓库/思想、为何这样选
     前端列出参考思想，可跳转查看/修改，可一键存入思想库
```

**分词要点**：`tokenize` 按中文单字 / 相邻二字组合（bigram）+ 英文单词建 token 集合，配合停用字符过滤，实现轻量中文检索（无需引入分词库）。

## 5. 核心：AI 接入层

| 场景 | 调用 | 说明 |
| --- | --- | --- |
| 智能问答 | `callAIStream`（SSE 流式） | 全量答案流式输出 |
| AI 连接测试 | `handleTestAI` | 发一条最小请求验证 baseUrl / apiKey / model 可用 |
| 学习判分 | `judgeStudyAnswer` | 对学习作答另行判分，更新存活率 |
| 演示模式 | `buildMockAnswer` | 未配置 apiKey 时，仅展示本地检索结果，不调 AI |

`config.json` 保存 baseUrl / apiKey / model / temperature / topK / userName / systemPrompt。**发布版不包含该文件**，使用方复制 `config.json.example` 并填入自己的密钥。

## 6. 文档导入流程

```
handleImportDoc
  ├─ .txt/.md/.log/.csv → decodeText() 自动识别 UTF-8/GBK → 提取为一条思想
  ├─ .docx → extractDocx()（解包 word/document.xml 提取段落）
  ├─ .zip  → unzip() → 递归处理包内所有 txt/md/docx，每文件一条思想
  └─ .doc  → 不支持，提示另存为 .docx/.txt
```

## 7. 学习模式（主动回忆训练）

在左侧菜单进入学习模式，用思想库做主动回忆：

- **选范围**：选择要复习的仓库（可多选），系统按 `pickStudyPoint` 挑知识点；
- **四阶段循环**：主动出题（带陷阱）→ 思维对抗（答错时扮演杠精用原文指漏洞）→ 极限压测（答对后换场景加难）→ 存活率监测（后台判分更新）；
- **存活率规则**：答对 +20，连续答对 3 次达 100 →「已掌握」每 3 天复习；答错 -30，<60 →「薄弱」每 1 小时复习；其余每 1 天复习。

## 8. 数据模型

| 文件 | 内容 |
| --- | --- |
| `data/thoughts.json` | 全部思想（标题、内容、标签、分类、所属仓库） |
| `data/repos.json` | 思想仓库（如工作 / 投资 / 学习） |
| `data/conversations.json` | 问答历史 |
| `data/study.json` | 学习模式存活率状态 |
| `config.json` | AI 接口配置（密钥仅存于此，已从发布版排除） |

## 9. 技术栈

| 层面 | 技术 |
| --- | --- |
| 后端 | Node.js 原生模块（http/fs/path/crypto/zlib），零第三方依赖 |
| 前端 | 原生 HTML / CSS / JS SPA，无框架 |
| 存储 | JSON 文件（原子写入），无数据库 |
| AI | OpenAI 兼容 Chat Completions（SSE 流式） |
| 启动 | `启动网站.bat` / `停止网站.bat`（自动探测端口与进程） |

## 10. 设计决策与扩展点

| 决策 | 权衡 |
| --- | --- |
| JSON 文件 + 原子写 | 简单可靠、数据可读可备份；容量与并发受限于单文件读写 |
| 轻量 bigram 检索 | 免分词库、离线可用；对长文本的语义召回依赖 AI 二次加工 |
| 零依赖后端 | 部署极简；无中间件与生态，复杂功能需手写 |

**扩展建议**：检索升级为向量化嵌入（接入 embedding API）、支持 SQLite 存储、增加标签体系、多设备同步等。

---

*本文档由源码逐模块梳理生成。*
