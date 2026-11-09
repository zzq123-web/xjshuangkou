const GAME_URL = 'https://xinjiang-shuangkou-game.authenticauk1.chatgpt.site/';

Page({
  data: {
    gameUrl: GAME_URL
  },

  onLoad(options) {
    const roomCode = options && options.room;
    if (!roomCode) return;
    this.setData({
      gameUrl: `${GAME_URL}?room=${encodeURIComponent(roomCode)}`
    });
  }
});
