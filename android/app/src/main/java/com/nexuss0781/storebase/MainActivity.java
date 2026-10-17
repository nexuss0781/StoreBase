package com.nexuss0781.storebase;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureCatalogPlugin.class);
        registerPlugin(StoreBaseUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
