# vendor/qrcode-generator

这个目录**不是我们写的代码**，是原样搬进来的第三方库。放在这里的理由和边界，写清楚：

| 项 | 值 |
|---|---|
| 包名 | [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) |
| 版本 | 2.0.4 |
| 作者 | Kazuhiko Arase |
| 许可 | MIT（版权声明保留在 `qrcode.mjs` 文件头，未做任何改动） |
| 依赖 | **零依赖**，单文件 |
| 用途 | 把"配对地址"画成终端里的二维码，供手机 App 扫描 |

## 为什么可以接受它（而插件不行）

- 它**不进 DSH 进程**，只是我们自己的小工具在本地跑一下，画完图就退出。
- 它实现的是 **ISO/IEC 18004 二维码标准**——一个冻结的算法，标准本身多年不变，
  所以它**不会像插件那样追着 DSH 的版本腐烂**。
- 它只被 `tools/dsh-mobile-pair.mjs` 引用；删掉这个目录，App 和 DSH 都不受影响
  （只是没法用扫码配对，改用菜单里手动填地址）。

## 升级/替换

要换版本：`npm pack qrcode-generator` → 用 `dist/qrcode.mjs` 覆盖本目录同名文件，
并同步更新本文件的版本号。**不要**在这里跑 `npm install`（本项目刻意不引入 node_modules）。
