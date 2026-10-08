package app.divinghq.mobile;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Uses Android's Print Framework, including its Save as PDF destination. */
@CapacitorPlugin(name = "DocumentPrinter")
public class DocumentPrinterPlugin extends Plugin {
    private boolean printing = false;
    private WebView documentView;

    @PluginMethod
    public void printDocument(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (printing) { call.reject("A print operation is already open"); return; }
            String html = call.getString("html");
            if (html != null && html.length() > 1024 * 1024) { call.reject("Document is too large"); return; }
            printing = true;
            if (html == null) { present(bridge.getWebView(), call, false); return; }
            documentView = new WebView(getContext());
            documentView.getSettings().setJavaScriptEnabled(false);
            documentView.getSettings().setAllowFileAccess(false);
            documentView.getSettings().setAllowContentAccess(false);
            documentView.getSettings().setBlockNetworkLoads(true);
            documentView.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) { present(view, call, true); }
            });
            documentView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }

    private void present(WebView view, PluginCall call, boolean owned) {
        PrintManager manager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
        if (manager == null) { printing = false; call.reject("Printing is unavailable"); return; }
        String name = call.getString("name", "DivingHQ");
        PrintDocumentAdapter delegate = view.createPrintDocumentAdapter(name);
        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
            @Override public void onStart() { delegate.onStart(); }
            @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancellation, LayoutResultCallback result, Bundle extras) {
                delegate.onLayout(oldAttributes, newAttributes, cancellation, result, extras);
            }
            @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellation, WriteResultCallback result) {
                delegate.onWrite(pages, destination, cancellation, result);
            }
            @Override public void onFinish() {
                delegate.onFinish();
                printing = false;
                if (owned && documentView != null) { documentView.destroy(); documentView = null; }
                call.resolve(new JSObject());
            }
        };
        manager.print(name, adapter, new PrintAttributes.Builder().build());
    }
}
