import UIKit
import Capacitor
import UserNotifications

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = DivingHQBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// Local plugin registration: https://capacitorjs.com/docs/ios/custom-code
class DivingHQBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NotificationSettingsPlugin())
        bridge?.registerPluginInstance(DocumentPrinterPlugin())
    }
}
@objc(NotificationSettingsPlugin)
public class NotificationSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NotificationSettingsPlugin"
    public let jsName = "NotificationSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNotificationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPushEnvironment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise)
    ]
    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let settingsURL: String
            if #available(iOS 16.0, *) { settingsURL = UIApplication.openNotificationSettingsURLString }
            else { settingsURL = UIApplication.openSettingsURLString }
            guard let url = URL(string: settingsURL) else { call.reject("Settings unavailable"); return }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("Could not open notification settings") }
            }
        }
    }
    @objc func getNotificationStatus(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["enabled": settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional])
        }
    }
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = enabled; call.resolve() }
    }
    @objc func getPushEnvironment(_ call: CAPPluginCall) {
        // Build setting also supplies aps-environment in App.entitlements.
        call.resolve(["environment": Bundle.main.object(forInfoDictionaryKey: "DivingHQPushEnvironment") as? String ?? "production"])
    }
}
