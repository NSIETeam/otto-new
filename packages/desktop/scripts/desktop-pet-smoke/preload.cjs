const { contextBridge } = require('electron');
// Synthetic state only: no connection to the real app, accounts or server.
const noSubscription = () => () => {};
contextBridge.exposeInMainWorld('otto', {
  themeGet: async () => 'dark',
  desktopPetGetState: async () => ({ running: false, workLabel: '透明窗口验证', sessionId: null }),
  onDesktopPetState: noSubscription,
  onDesktopPetReaction: noSubscription,
  onDesktopPetNativeDragEnd: noSubscription,
  desktopPetSetInteractive: () => {},
  desktopPetDragStart: async () => {},
  desktopPetDragEnd: async () => false,
  desktopPetOpenMain: async () => {},
  desktopPetShowMenu: async () => {},
});
