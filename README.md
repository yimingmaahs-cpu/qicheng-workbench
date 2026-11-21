# 启程 · 求职工作台

适用于 Windows 10/11 x64。每个人在自己的电脑管理简历、岗位和投递记录，可以使用 Edge 登录招聘网站采集、从微信或 QQ 文本导入招聘信息，也可以自行绑定邮箱和配置模型服务。

## 下载和更新

1. 前往 [最新正式版](https://github.com/Yimingmaahs-CPU/qicheng-workbench/releases/latest)，下载 **Qicheng-Windows-x64.zip**。
2. 右键选择“全部解压”，把文件留在同一个可写目录，双击 **开始使用.cmd**。首次启动会建立空白的“我的数据”。
3. 使用期间请保留启动窗口。保存工作后在启动窗口按 **Ctrl+C** 退出。下次双击启动时，程序会检查正式版、校验安装包并自动使用新版本。暂时无法连接 GitHub 时，可以继续使用已安装版本。
4. 使用期间每 5 分钟检查更新；页面出现提示后，可保存工作、退出并重新启动。请一直从原解压目录启动，让新版继续使用同一份数据。

模型设置与邮箱绑定初始为空。请自行填写并保管自己的凭据。“我的数据”包含私人记录和登录状态；分享给朋友时，请转发上面的下载页。

## 开发与发布

使用 Windows、Node.js 24 或更新版本。在仓库目录运行 `npm ci`、`npm test`、`npm start`，然后打开 http://127.0.0.1:4320 。源码模式默认使用当前目录的 local-data。

维护者在本仓库修改程序，运行 `npm version patch` 提升修复版本（功能版本用 `npm version minor`），然后运行 `git push --follow-tags origin main`。GitHub Actions 会测试带 v 标签的提交，在 Windows 上构建并发布正式安装包。只有发布成功的正式版会发给客户端。也可运行 `npm run package` 在本机生成安装包。

