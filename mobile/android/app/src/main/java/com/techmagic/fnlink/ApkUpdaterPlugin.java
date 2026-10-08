package com.techmagic.fnlink;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Обновление приложения из релизов GitHub.
 * Скачивает APK и открывает системное окно установки Android.
 * Подтвердить установку пользователь должен сам: Android не разрешает
 * обычным приложениям устанавливать APK молча.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    // Скачивать разрешено только из релизов нашего репозитория.
    private static final String ALLOWED_PREFIX =
            "https://github.com/TechMagicInfinity13/FNLink/releases/download/";

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext()
                    .getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("version", info.versionName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось определить версию", e);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.startsWith(ALLOWED_PREFIX)) {
            call.reject("Недопустимый адрес обновления");
            return;
        }

        // Android 8+: у приложения должно быть разрешение «Установка неизвестных
        // приложений». Если его нет, открываем нужную страницу настроек.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            JSObject needs = new JSObject();
            needs.put("status", "needs_permission");
            call.resolve(needs);
            return;
        }

        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists()) {
                    dir.mkdirs();
                }
                File apk = new File(dir, "update.apk");

                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);

                int code = conn.getResponseCode();
                if (code != 200) {
                    call.reject("Сервер ответил кодом " + code);
                    return;
                }

                long total = conn.getContentLengthLong();
                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[65536];
                    long done = 0;
                    int lastPercent = -1;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int percent = (int) (done * 100 / total);
                            if (percent != lastPercent) {
                                lastPercent = percent;
                                JSObject progress = new JSObject();
                                progress.put("percent", percent);
                                notifyListeners("progress", progress);
                            }
                        }
                    }
                }

                Uri uri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);

                JSObject result = new JSObject();
                result.put("status", "installing");
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Не удалось скачать обновление: " + e.getMessage(), e);
            }
        }).start();
    }
}
