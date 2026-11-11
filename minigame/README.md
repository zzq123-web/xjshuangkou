# 新疆双扣微信小游戏版

这个目录是独立的微信小游戏项目，原来的网页版本和小程序版本保持不变。

## 导入

1. 在微信开发者工具首页选择“小游戏”。
2. 项目目录选择本目录。
3. 把 `project.config.json` 里的 `touristappid` 换成微信后台创建的小游戏 AppID。
4. 如果要真机或正式发布，把 `game.js` 里的 `API_BASE_URL` 配置到微信后台的服务器域名中。

小游戏版使用 Canvas 绘制牌桌，通过现有房间接口创建房间、加入房间、争庄、上供、还牌、叫队友和出牌。服务器继续负责规则判定和房间状态保存。

当前默认接口地址是 `https://xinjiang-shuangkou-game.authenticauk1.chatgpt.site`。这个地址当前是私有 Site，正式给其他微信用户使用时需要准备公开的 HTTPS 服务域名。
