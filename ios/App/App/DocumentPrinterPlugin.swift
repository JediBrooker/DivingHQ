// Native print/save-PDF presentation for profile dashboards and translated
// payment ledgers. No remote URL or filesystem path is accepted by this bridge.
import UIKit
import Capacitor

@objc(DocumentPrinterPlugin)
public class DocumentPrinterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DocumentPrinterPlugin"
    public let jsName = "DocumentPrinter"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "printDocument", returnType: CAPPluginReturnPromise)
    ]
    private var printing = false

    @objc func printDocument(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard !self.printing, let webView = self.bridge?.webView else {
                call.reject("A print operation is already open")
                return
            }
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = String((call.getString("name") ?? "DivingHQ").prefix(100))
            info.outputType = .general
            controller.printInfo = info
            if let html = call.getString("html") {
                guard html.utf8.count <= 1024 * 1024 else { call.reject("Document is too large"); return }
                controller.printFormatter = UIMarkupTextPrintFormatter(markupText: html)
            } else {
                controller.printFormatter = webView.viewPrintFormatter()
            }
            self.printing = true
            let completion: UIPrintInteractionController.CompletionHandler = { _, _, error in
                self.printing = false
                if let error = error { call.reject("Could not print document", nil, error) }
                else { call.resolve() }
            }
            if UIDevice.current.userInterfaceIdiom == .pad {
                controller.present(from: CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1), in: webView, animated: true, completionHandler: completion)
            } else {
                controller.present(animated: true, completionHandler: completion)
            }
        }
    }
}
