// GoLibraryBridge.swift
import Foundation
import React
import MergedLib
import Darwin

class EventListener: NSObject, MergedlibEventProtocol {
    private var onProcessExitCallack: RCTResponseSenderBlock?
    private var onShutdownCallback: RCTResponseSenderBlock?
    private var onStartErrorCallback: RCTResponseSenderBlock?

    init(onProcessExit: @escaping RCTResponseSenderBlock, onShutdown: @escaping RCTResponseSenderBlock, onStartError: @escaping RCTResponseSenderBlock) {
        self.onProcessExitCallack = onProcessExit
        self.onShutdownCallback = onShutdown
        self.onStartErrorCallback = onStartError
    }
  
    func onProcessExit(_ code: Int) {
        self.onProcessExitCallack?([["code": code]])
        print("Process exited with code \(code).")
    }

    func onShutdown(_ t: String?) {
        self.onShutdownCallback?([["t": t]])
        print("Shutdown initiated: \(t ?? "No additional information")")
    }

    func onStartError(_ t: String?, err: String?) {
        self.onStartErrorCallback?([["t": t, "err": err]])
        print("Start error: \(err ?? "Unknown Error")")
    }
}

class LogCallbackHandler: NSObject, MergedlibLogCallbackProtocol {
    private var onLogCallback: RCTResponseSenderBlock? // 用于存储JavaScript的回调函数

    init(onLog: @escaping RCTResponseSenderBlock) {
        self.onLogCallback = onLog
    }

    func onLog(_ level: Int16, time: Int64, message: String?) {
        self.onLogCallback?([["level": level, "time": time, "message": message ?? ""]])
        print("Log message at level \(level): \(message ?? "No message")")
    }
}

class DataChangeCallbackHandler: NSObject, MergedlibDataChangeCallbackProtocol {
  var debounceTimer: Timer?
  func onChange(_ model: String?) {
    #if WITH_ICLOUD
    if (CloudKitManager.shared.restoring) {
      return
    }
    if (!UserDefaults.standard.bool(forKey: "iCloudSync")) {
      return
    }
    print("data onChange: \(String(describing: model))")
    DispatchQueue.main.async {
      self.debounceTimer?.invalidate()
      self.debounceTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false, block: { (timer) in
        let data = MergedlibBackup()
        CloudKitManager.shared.saveRecord(recordFields: ["json" : data]) { _ in
          print("备份数据成功")
        } reject: { msg in
          print("备份数据失败: \(String(describing: msg))")
        }
      })
    }
    #endif
  }
}

@objc(Alist)
class Alist: RCTEventEmitter {
  @objc func `init`(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let libType = UserDefaults.standard.integer(forKey: "libType")
    MergedlibSetLibType(libType)
    
    let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!

    let eventListener = EventListener(
      onProcessExit: { [weak self] (body) in
        self?.sendEvent(withName: "onProcessExit", body: body?[0])
      },
      onShutdown: { [weak self] (body) in
        self?.sendEvent(withName: "onShutdown", body: body?[0])
      },
      onStartError: { [weak self] (body) in
        self?.sendEvent(withName: "onStartError", body: body?[0])
      }
    )

    let logCallbackHandler = LogCallbackHandler(onLog: { [weak self] (logInfo) in
      self?.sendEvent(withName: "onLog", body: logInfo?[0])
    })

    // 初始化 NSError 的指针
    var error: NSError?
    MergedlibSetConfigData(libType == 0 ? documentsDirectory.path : documentsDirectory.appendingPathComponent("OpenList").path)
    MergedlibSetConfigLogStd(true)
    MergedlibInit(eventListener, logCallbackHandler, &error)
    if (error == nil) {
      resolve("ok")
    } else {
      reject("server start", "服务启动失败", error)
    }
  }

  @objc func start(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let dataChangeCallbackHandler = DataChangeCallbackHandler()
    MergedlibStart(dataChangeCallbackHandler)
    resolve("ok")
  }

  @objc func stop(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    var error: NSError?
    MergedlibShutdown(0, &error)

    if (error == nil) {
      NotificationManager.shared.removeNotification()
      resolve("ok")
    } else {
      reject("server stop", "服务停止失败", error)
    }
  }

  @objc func isRunning(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibIsRunning("http"))
  }

  @objc func getAdminPassword(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetAdminPassword())
  }

  @objc func getAdminUsername(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetAdminUsername())
  }
  
  @objc func getAdminToken(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetAdminToken())
  }

  @objc func getOutboundIPString(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetOutboundIPString())
  }

  @objc func setAdminPassword(_ password: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    MergedlibSetAdminPassword(password)
    resolve("ok")
  }
  
  @objc func iCloudSwitch(_ value: Bool, resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    UserDefaults.standard.set(value, forKey: "iCloudSync")
  }
  
  @objc func iCloudRestore(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if WITH_ICLOUD
    CloudKitManager.shared.restore { data in
      resolve(data)
    } reject: { msg in
      reject("iCloudError", msg, nil)
    }
    #else
    resolve("ok")
    #endif
  }
  
  @objc func iCloudBackup(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if WITH_ICLOUD
    CloudKitManager.shared.backup { data in
      resolve(data)
    } reject: { msg in
      reject("iCloudError", msg, nil)
    }
    #else
    resolve("ok")
    #endif
  }
  
  @objc func setAutoStopHours(_ value: NSNumber, resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    MergedlibSetAutoStopHours(Int(value.intValue))
  }
  
  @objc func getVersion(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetVersion())
  }
  
  @objc func getAListVersion(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetAListVersion())
  }
  
  @objc func getOpenListVersion(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MergedlibGetOpenListVersion())
  }
  
  @objc func setLibType(_ value: NSNumber, resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    UserDefaults.standard.set(value, forKey: "libType")
    MergedlibSetLibType(Int(truncating: value))
    resolve("ok")
  }
  
  @objc func exit(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve("ok")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      Darwin.exit(0)
    }
  }

  // React Native桥接需要的因素
  @objc override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
      return ["onLog", "onProcessExit", "onShutdown", "onStartError"]
  }
}
