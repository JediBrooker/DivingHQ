package app.divinghq.mobile;

import android.app.NotificationManager;
import android.os.Build;
import android.content.Intent;
import android.provider.Settings;
import android.net.Uri;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

@CapacitorPlugin(name = "NotificationSettings")
public class NotificationSettingsPlugin extends Plugin {
    @PluginMethod public void openNotificationSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        }
        try { getActivity().startActivity(intent); call.resolve(); }
        catch (Exception e) { call.reject("Could not open notification settings"); }
    }
    @PluginMethod public void getNotificationStatus(PluginCall call) {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            android.app.NotificationChannel channel = manager.getNotificationChannel("divinghq_updates");
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) enabled = false;
        }
        JSObject result = new JSObject(); result.put("enabled", enabled);
        result.put("configured", getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName()) != 0);
        call.resolve(result);
    }
    // The Capacitor plugin resolves unregister before deleteToken finishes.
    // Await the actual SDK Task so a subsequent account cannot register a token
    // which an older logout is still deleting. Auto-init stays off on failure.
    // https://firebase.google.com/docs/reference/android/com/google/firebase/messaging/FirebaseMessaging
    @PluginMethod public void unregisterPush(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) { call.resolve(); return; }
        try {
            FirebaseMessaging messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(false);
            messaging.deleteToken().addOnCompleteListener(task -> {
                if (task.isSuccessful()) call.resolve();
                else call.reject("Notification token cleanup is waiting for a connection");
            });
        } catch (IllegalStateException e) {
            call.reject("Notification token cleanup is unavailable");
        }
    }
    @PluginMethod public void setKeepAwake(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
    @PluginMethod public void getPushEnvironment(PluginCall call) {
        JSObject result = new JSObject(); result.put("environment", "production"); call.resolve(result);
    }
}
