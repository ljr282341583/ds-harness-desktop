'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 最小暴露：只读版本号 + 端口查询 + 错误信息 + 重启服务（供内置错误页使用）
contextBridge.exposeInMainWorld('dshDesktop', {
  version: '0.2.0',
  getPort: () => ipcRenderer.invoke('dsh:get-port'),
  getError: () => ipcRenderer.invoke('dsh:get-error'),
  restart: () => ipcRenderer.invoke('dsh:restart'),
});
