import UIKit
import React
import Expo
#if WITH_ICLOUD
import CloudKit
#endif

@UIApplicationMain
class AppDelegate: EXAppDelegateWrapper {
    override func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        self.moduleName = "main"
        self.initialProps = [String: Any]();
        application.registerForRemoteNotifications()
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    override func sourceURL(for bridge: RCTBridge!) -> URL! {
        return self.bundleURL()
    }

    override func bundleURL() -> URL {
        #if DEBUG
        return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry", fallbackExtension: nil)!
        #else
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")!
        #endif
    }

    override func application(_ application: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey : Any] = [:]) -> Bool {
        return super.application(application, open: url, options: options) || RCTLinkingManager.application(application, open: url, options: options)
    }

    override func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
        return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
    }

    override func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        print("Did register for remote notifications")
        super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
    }

    override func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("ERROR: Failed to register for notifications: \(error.localizedDescription)")
        super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
    }

    override func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable : Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        #if WITH_ICLOUD
        let cloudKitNotification = CKNotification(fromRemoteNotificationDictionary: userInfo)
            
        if(cloudKitNotification?.subscriptionID == "backup") {
          print("接收到iCloud远程通知")
          let iCloudSync: Bool = UserDefaults.standard.bool(forKey: "iCloudSync")
          if (iCloudSync) {
            CloudKitManager.shared.restore(resolve: {_ in
            }, reject: {_ in
            })
          }
        }
        #endif
        super.application(application, didReceiveRemoteNotification: userInfo, fetchCompletionHandler: completionHandler)
    }
  
    override func applicationWillTerminate(_ application: UIApplication) {
        NotificationManager.shared.removeNotification()
    }
}
