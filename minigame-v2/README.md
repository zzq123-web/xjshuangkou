# 新疆双扣微信小游戏 v2

这是独立的微信小游戏版本，原网页版、原小程序版，以及原来的 `minigame` 目录都不变。

## 导入微信开发者工具

1. 选择“小游戏”。
2. 项目目录选择：`D:\ChatGPT\双扣\minigame-v2`。
3. 不要选择上一级 `D:\ChatGPT\双扣`，因为小游戏入口文件 `game.json` 在本目录中。
4. 预览时可使用 `touristappid`；正式开发时把 `project.config.json` 中的 `appid` 换成你的小游戏 AppID。
5. 在微信公众平台的“开发管理 → 开发设置 → 服务器域名”中，把 `https://xinjiang-shuangkou-game.authenticauk1.chatgpt.site` 加入 request 合法域名。

## 联机说明

`game.js` 使用服务端房间接口，支持创建房间、加入房间、争庄、上供、还牌、叫队友和出牌。每位玩家只会收到自己的手牌和私密换牌记录。

当前接口地址：

`https://xinjiang-shuangkou-game.authenticauk1.chatgpt.site`

小游戏预览或真机调试前，必须先在微信后台配置合法域名；没有 AppID 时只能使用游客预览，不能提交发布。
