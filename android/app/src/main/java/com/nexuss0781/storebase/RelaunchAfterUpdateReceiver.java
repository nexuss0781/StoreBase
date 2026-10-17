package com.nexuss0781.storebase;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class RelaunchAfterUpdateReceiver extends BroadcastReceiver {
    private static final String TAG = "StoreBaseUpdate";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(launch);
        } catch (RuntimeException error) {
            // Android may defer background launches; the installer still offers its Open action.
            Log.i(TAG, "Android deferred automatic relaunch after update.");
        }
    }
}
