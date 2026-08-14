# PokéCamp 队伍导入

PokéCamp 的公开页面目前可能返回 Cloudflare 人机验证页。项目不会绕过验证，也不会把验证页当作队伍数据抓取。

## 导入 JSON

从 PokéCamp 页面导出队伍 JSON 后运行：

```powershell
npm run import:pokecamp -- .\pokecamp-export.json
```

可选环境变量：

```powershell
$env:FORMAT="double"
$env:SEASON="M-B"
$env:REGULATION="M-B"
$env:RULESET_ID="champions-double-mb-..."
npm run import:pokecamp -- .\pokecamp-export.json
```

也可以调用 API：

```text
POST /api/pokecamp/teams/import
```

请求体可以是 `payload`、`data`、`teams` 或 `items`，支持数组、`{ teams: [...] }` 和单个队伍对象。

导入字段包括：

- 单打 / 双打与赛季、regulation、rulesetId
- 队伍名称、作者、租借码、使用率、排名、详情链接
- 六只宝可梦及形态、图片、中文名
- 道具、特性、性格、招式、EV/IV、等级、太晶属性
- 单宝可梦功能定位、玩法备注、队伍首发、核心与 matchup 说明

导入后会按队伍稳定 ID 合并，不覆盖其他来源。排位和配队使用前仍必须通过当前规则的 Showdown TeamValidator 与官方可用池校验。
