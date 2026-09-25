'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 最小暴露：版本信息 + 端口查询 + 错误信息 + 重启服务 + 应用内更新 + 手机访问
// 注意：版本号不再写死，统一经 IPC 读取主进程中的真实值。
contextBridge.exposeInMainWorld('dshDesktop', {
  getVersions: () => ipcRenderer.invoke('dsh:get-versions'),
  getPort: () => ipcRenderer.invoke('dsh:get-port'),
  getError: () => ipcRenderer.invoke('dsh:get-error'),
  restart: () => ipcRenderer.invoke('dsh:restart'),
  checkForUpdates: () => ipcRenderer.invoke('dsh:update-check'),
  setUpdateChannel: (channel) => ipcRenderer.invoke('dsh:update-channel', channel),
  rollbackToBundled: () => ipcRenderer.invoke('dsh:update-rollback'),
  checkShellUpdate: () => ipcRenderer.invoke('dsh:shell-update-check'),
  installShellUpdate: () => ipcRenderer.invoke('dsh:shell-update-install'),
  // 手机访问：配对二维码小窗用；状态/开关也可给主界面用
  mobileStatus: () => ipcRenderer.invoke('mobile:status'),
  mobileQr: () => ipcRenderer.invoke('mobile:qr'),
  mobileSetEnabled: (enabled) => ipcRenderer.invoke('mobile:set-enabled', enabled),
  mobileSetPreferIp: (preferIp) => ipcRenderer.invoke('mobile:set-prefer-ip', preferIp),
  mobileCopyAddress: () => ipcRenderer.invoke('mobile:copy-address'),
  mobileShowQr: () => ipcRenderer.invoke('mobile:show-qr'),
});
