package app.divinghq.mobile;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NotificationSettingsPlugin.class);
        registerPlugin(DocumentPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
