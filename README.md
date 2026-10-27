# 任意包 / AnyPkg

AnyPkg 是一个在本地运行的应用安装包搜索与下载工具。输入应用名称，即可查找 Android、iOS、Windows、macOS 和 Linux 的应用；支持直接下载的结果可以加入下载队列，其余结果提供商店入口。

## 这是什么

- 一次搜索多个平台，按系统或“可直接下载”筛选结果。
- 查看应用版本、安装包大小和可用下载来源。
- 将多个安装包加入下载队列，查看进度、速度，取消或重试任务。
- 连接手机后，可将下载完成的安装包装到设备。

## 怎么用

### 启动

需要 Node.js 20 或更高版本；建议使用 Node.js 22 或更高版本，以启用 Windows 应用搜索。

```bash
git clone https://github.com/h824612113/AnyPkg.git
cd AnyPkg
npm start
```

打开浏览器访问 **http://localhost:8787**。基础搜索和下载无需安装 npm 依赖，服务默认仅允许本机访问。

### 搜索与下载

1. 输入应用名称，例如“微信”“Figma”或“OBS”，点击“搜索”。
2. 选择 Android、iOS、Windows、macOS 等分类，或点击“可直接下载”筛选结果。
3. 点击应用卡片上的下载按钮，或点击“+”加入下载队列；仅提供商店入口的结果会跳转到对应商店。
4. 在下载队列中查看进度和速度。任务失败后可点击“重试”，下载完成后可在页面取回文件。

安装包保存在本地。下载目录占用达到 10 GiB 后会暂停接收新下载，需要手动清理；不会自动删除已有文件。

### 可选功能

**下载 App Store 安装包**

在 macOS 上安装 ipatool：

```bash
brew install ipatool
```

刷新页面，点击顶部 App Store 状态栏的“连接账号”，按提示登录自己的 Apple ID。可用应用会提供 IPA / PKG 下载入口；下载资格和安装范围受账号、购买记录及地区限制。

**下载 Google Play 安装包**

需预先安装 Python 3.11、Java 17 和 Android SDK 的 apksigner，然后在项目目录执行：

```bash
python3.11 -m venv gplay-server/.venv
gplay-server/.venv/bin/python -m pip install -r gplay-server/requirements.txt
```

刷新页面，按 Google Play 状态栏提示连接账号，再搜索应用或使用“直下 APK”输入应用链接或包名。合并后的 APK 使用调试签名，不能直接覆盖安装签名不同的官方版本。

**安装到手机**

Android 设备需要 adb，iOS 设备需要 pymobiledevice3。连接并授权设备后，在页面选择设备，再使用“装到手机”；能否安装取决于安装包签名、设备和账号权限。

**接入 AI 客户端**

启动服务后，在支持 Streamable HTTP 的 MCP 客户端中添加地址 `http://127.0.0.1:8787/mcp`，即可通过 AI 搜索应用、下载安装包、查看进度和安装到设备。

## 效果图

截图不含账号或设备信息，下载队列使用虚构任务演示。

### 全平台搜索

![全平台搜索结果](output/playwright/search-results.png)

### 可直接下载筛选

![仅显示可直接下载的结果](output/playwright/direct-downloads.png)

### 下载队列

![下载队列与分段进度](output/playwright/download-queue.png)
