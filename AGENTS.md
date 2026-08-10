# alist-expo 开发说明

## iOS Debug 启动流程

这是 Expo + React Native + 原生 iOS 模块的混合项目，不能只用 Expo Go 验证全部功能。调试时应运行仓库内的原生 `alist` App，并由 Metro 提供 JavaScript bundle。

### 1. 准备 MergedLib

项目依赖本机 `alist-swift` 生成的 MergedLib：

```text
/Users/codex/code/alist-swift/AListServer/MergedLib.xcframework
```

目标位置为：

```text
/Users/codex/code/alist-expo/ios/alist/MergedLib.xcframework
```

如果目标不存在或需要更新，先将前者完整复制到目标位置。不要修改或提交 xcframework 内的生成文件；该目录在正常开发中应作为本地产物使用。

```bash
ditto \
  /Users/codex/code/alist-swift/AListServer/MergedLib.xcframework \
  /Users/codex/code/alist-expo/ios/alist/MergedLib.xcframework
```

### 2. 安装依赖

在项目根目录执行：

```bash
cd /Users/codex/code/alist-expo
yarn
cd ios
pod install
cd ..
```

项目使用 Yarn 1。没有明确需要时，不要升级依赖、重建 lockfile 或执行会大范围更新 Pods 的命令。

### 3. 启动 Metro

在项目根目录保持以下命令持续运行：

```bash
cd /Users/codex/code/alist-expo
yarn start --localhost
```

确认日志出现 Metro 正在监听 `127.0.0.1:8081` 后，再从 Xcode 或 `simctl` 启动 App。

Debug App 不包含独立的 `main.jsbundle`，必须先启动 Metro。若 Metro 未启动，`AppDelegate.swift` 中获取 bundle URL 的强制解包可能导致 App 启动即崩溃；这不是 MergedLib、签名或 CloudKit 故障。

### 4. 使用 Xcode 运行

必须打开 CocoaPods workspace，而不是 `.xcodeproj`：

```bash
open /Users/codex/code/alist-expo/ios/alist.xcworkspace
```

在 Xcode 中：

1. 选择 `alist` scheme。
2. 选择需要的 iPhone 模拟器或已连接的 iPhone/iPad。
3. 确认 Metro 已运行。
4. 点击 Run。

也可以先用下面命令查询模拟器，再使用其 UDID 构建；不要在脚本或文档中写死某一台模拟器的 UDID：

```bash
xcrun simctl list devices available
xcodebuild \
  -workspace ios/alist.xcworkspace \
  -scheme alist \
  -configuration Debug \
  -destination 'id=<模拟器 UDID>' \
  -derivedDataPath /tmp/alist-debug-derived \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build
```

构建完成后可安装并启动：

```bash
xcrun simctl install <模拟器 UDID> /tmp/alist-debug-derived/Build/Products/Debug-iphonesimulator/alist.app
xcrun simctl launch <模拟器 UDID> com.gendago.alist
```

### 5. 签名和 iCloud 调试

当前 iOS target 使用：

- Bundle ID：`com.gendago.alist`
- Entitlements：`ios/alist/alist.entitlements`
- iCloud container：`iCloud.com.gendago.alist`
- Swift 编译条件：需要包含 `WITH_ICLOUD`

设置页的“iCloud 同步”并非静态显示。页面会调用 `CloudKitManager.getUserRecordID()`，只有成功获得 iCloud 用户记录 ID 后才渲染该行。因此在模拟器中测试时，需要先在模拟器的系统设置里登录 iCloud，然后重新启动 App/重新进入设置页。未登录时不显示 iCloud 同步项，不代表 `WITH_ICLOUD` 没有编译。

要验证真正的设备签名和 CloudKit entitlement，应构建 `iphoneos` 产物，不能只根据模拟器构建判断：

```bash
xcodebuild \
  -workspace ios/alist.xcworkspace \
  -scheme alist \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/alist-device-derived \
  -allowProvisioningUpdates \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build
```

构建后检查最终产物，而不只是检查 Xcode 配置页：

```bash
APP=/tmp/alist-device-derived/Build/Products/Debug-iphoneos/alist.app
codesign -dv --verbose=4 "$APP"
codesign -d --entitlements :- "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

应确认最终 entitlement 中包含 `com.apple.developer.icloud-container-identifiers` 和 `com.apple.developer.icloud-services = CloudKit`。完整 CloudKit 读写仍应在已加入 provisioning profile 的实体 iPhone/iPad 上验证。

## 调试注意事项

- 修改或构建前先运行 `git status --short`，不要覆盖工作区中已有的未提交改动。
- `pod install`、Xcode 自动签名和 Xcode 工程设置可能改变 `Podfile.lock` 或 `project.pbxproj`；提交前必须逐项 review，不能把本地签名或无关改动混入业务提交。
- 启动失败时先分别确认 Metro、原生构建、签名/entitlement 和 CloudKit 登录状态，不要把不同层的问题混为一类。
- 验证设置页 iCloud 功能时，以页面是否显示用户记录 ID、原生日志和最终签名 entitlement 为准。
