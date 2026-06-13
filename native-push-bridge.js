(function () {
  const BACKEND_URL_KEY = 'noir_webpush_backend_url';
  const BACKEND_ENABLED_KEY = 'noir_webpush_enabled';
  const SUBSCRIBED_KEY = 'noir_webpush_subscribed';
  const TOKEN_KEY = 'noir_native_push_token';
  const LAST_SYNCED_BACKEND_KEY = 'noir_native_push_last_backend_url';

  let listenersReady = false;
  let registerInFlight = false;
  let nativeBuildConfigPromise = null;

  const cleanUrl = (url) => String(url || '').replace(/\/+$/, '');

  const getCapacitor = () => window.Capacitor || null;
  const getPlatform = () => {
    const capacitor = getCapacitor();
    if (!capacitor) return 'web';
    if (typeof capacitor.getPlatform === 'function') return capacitor.getPlatform();
    return capacitor.platform || 'web';
  };

  const isNativeAndroid = () => {
    const capacitor = getCapacitor();
    if (!capacitor) return false;
    const nativePlatform = typeof capacitor.isNativePlatform === 'function'
      ? capacitor.isNativePlatform()
      : getPlatform() !== 'web';
    return nativePlatform && getPlatform() === 'android';
  };

  const getPush = () => getCapacitor()?.Plugins?.PushNotifications || null;
  const getLocal = () => getCapacitor()?.Plugins?.LocalNotifications || null;

  const loadNativeBuildConfig = async () => {
    if (!isNativeAndroid()) return null;

    if (!nativeBuildConfigPromise) {
      const configUrl = new URL('native-build-config.json', window.location.href).toString();
      nativeBuildConfigPromise = fetch(configUrl, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) return null;

          const json = await response.json();
          return json && typeof json === 'object' ? json : null;
        })
        .catch((error) => {
          console.warn('[native-push-bridge] Failed to load native build config:', error);
          return null;
        });
    }

    return nativeBuildConfigPromise;
  };

  const openPendingDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('roche-push-pending', 2);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pendingPushResponses')) {
        db.createObjectStore('pendingPushResponses', { keyPath: 'requestId' });
      }
      if (!db.objectStoreNames.contains('appState')) {
        db.createObjectStore('appState');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const savePendingResponse = async (data) => {
    const db = await openPendingDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('pendingPushResponses', 'readwrite');
      tx.objectStore('pendingPushResponses').put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  const notifyAppToProcessPending = (detail) => {
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new CustomEvent('roche-native-push-received', {
        detail: detail || {}
      }));
    } catch (error) {
      console.warn('[native-push-bridge] Failed to notify app runtime:', error);
    }
  };

  const syncTokenToBackend = async (token, backendUrl) => {
    const url = cleanUrl(backendUrl);
    if (!url || !token) return;

    const response = await fetch(`${url}/subscribe/native`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        platform: 'android',
        appId: 'com.roche.app'
      })
    });

    if (!response.ok) {
      const errorText = (await response.text()).trim();
      throw new Error(`Native subscribe failed: ${response.status}${errorText ? ` ${errorText}` : ''}`);
    }

    localStorage.setItem(LAST_SYNCED_BACKEND_KEY, url);
  };

  const preloadPendingResult = async (rawData, options = {}) => {
    const requestId = String(rawData?.requestId || '');
    const backendUrl = cleanUrl(rawData?.backendUrl || localStorage.getItem(BACKEND_URL_KEY) || '');
    let resolvedChatId = String(rawData?.chatId || rawData?.conversationId || '');
    const openedFromAction = options.openedFromAction === true;

    if (!requestId || !backendUrl) {
      notifyAppToProcessPending({
        ...(rawData || {}),
        chatId: resolvedChatId,
        conversationId: resolvedChatId,
        openedFromAction
      });
      return;
    }

    try {
      const response = await fetch(`${backendUrl}/api/result/${requestId}`);
      if (response.ok) {
        const result = await response.json();
        resolvedChatId = String(result.chatId || resolvedChatId || '');
        await savePendingResponse({
          ...result,
          requestId,
          chatId: resolvedChatId,
          charId: result.charId || rawData?.charId || '',
          pushType: result.pushType || rawData?.type || 'ai_response',
          chatTitle: result.chatTitle || rawData?.title || 'Roche',
          timestamp: result.timestamp || Date.now(),
          backendUrl,
          processed: false
        });
      }
    } catch (error) {
      console.warn('[native-push-bridge] Failed to preload pending result:', error);
    }

    notifyAppToProcessPending({
      ...(rawData || {}),
      requestId,
      chatId: resolvedChatId,
      conversationId: resolvedChatId,
      backendUrl,
      openedFromAction
    });
  };

  const ensureChannel = async () => {
    const push = getPush();
    if (!push?.createChannel) return;

    try {
      await push.createChannel({
        id: 'roche_messages',
        name: 'Roche Messages',
        description: 'Roche push notifications',
        importance: 5,
        visibility: 1,
        sound: 'default',
        vibration: true
      });
    } catch (error) {
      console.warn('[native-push-bridge] Failed to create channel:', error);
    }
  };

  const setupListeners = async () => {
    if (listenersReady || !isNativeAndroid()) return;

    const push = getPush();
    if (!push?.addListener) return;

    listenersReady = true;

    await push.addListener('registration', async (token) => {
      const value = token?.value || '';
      if (!value) return;

      localStorage.setItem(TOKEN_KEY, value);
      localStorage.setItem(SUBSCRIBED_KEY, 'true');

      const backendUrl = cleanUrl(localStorage.getItem(BACKEND_URL_KEY) || '');
      if (backendUrl) {
        try {
          await syncTokenToBackend(value, backendUrl);
        } catch (error) {
          console.warn('[native-push-bridge] Failed to sync token automatically:', error);
        }
      }
    });

    await push.addListener('registrationError', (error) => {
      console.error('[native-push-bridge] Registration error:', error);
    });

    await push.addListener('pushNotificationReceived', async (notification) => {
      await preloadPendingResult(notification?.data || {}, { openedFromAction: false });
    });

    await push.addListener('pushNotificationActionPerformed', async (action) => {
      await preloadPendingResult(action?.notification?.data || {}, { openedFromAction: true });
    });
  };

  const requestPermission = async () => {
    const local = getLocal();
    const push = getPush();

    try {
      await local?.requestPermissions?.();
    } catch (error) {
      console.warn('[native-push-bridge] Local notification permission request failed:', error);
    }

    const result = await push?.requestPermissions?.();
    return result?.receive || 'default';
  };

  const ensureRegistered = async () => {
    if (!isNativeAndroid() || registerInFlight) return;

    const backendEnabled = localStorage.getItem(BACKEND_ENABLED_KEY) === 'true';
    const backendUrl = cleanUrl(localStorage.getItem(BACKEND_URL_KEY) || '');
    if (!backendEnabled || !backendUrl) return;

    registerInFlight = true;

    try {
      await setupListeners();
      await ensureChannel();

      const permission = await requestPermission();
      if (permission !== 'granted') return;

      const existingToken = localStorage.getItem(TOKEN_KEY) || '';
      const lastSyncedBackend = cleanUrl(localStorage.getItem(LAST_SYNCED_BACKEND_KEY) || '');
      if (existingToken && lastSyncedBackend === backendUrl) return;

      if (existingToken) {
        await syncTokenToBackend(existingToken, backendUrl);
        return;
      }

      const buildConfig = await loadNativeBuildConfig();
      if (buildConfig?.androidFirebaseConfigured === false) {
        console.warn('[native-push-bridge] Firebase Android config is missing, skip native registration.');
        return;
      }

      await getPush()?.register?.();
    } catch (error) {
      console.warn('[native-push-bridge] Native registration failed:', error);
    } finally {
      registerInFlight = false;
    }
  };

  const sendTestNotification = async () => {
    const local = getLocal();
    if (!local?.schedule) return false;

    await requestPermission();
    await local.schedule({
      notifications: [
        {
          id: Date.now() % 2147483647,
          title: 'Noir Studio',
          body: 'This is a native Android notification test.',
          schedule: { at: new Date(Date.now() + 1000) }
        }
      ]
    });
    return true;
  };

  window.__rocheNativePush = {
    ensureRegistered,
    requestPermission,
    sendTestNotification
  };

  if (!isNativeAndroid()) return;

  setupListeners().catch((error) => {
    console.warn('[native-push-bridge] Listener setup failed:', error);
  });

  ensureRegistered().catch((error) => {
    console.warn('[native-push-bridge] Initial native registration failed:', error);
  });

  setInterval(() => {
    ensureRegistered().catch((error) => {
      console.warn('[native-push-bridge] Periodic native registration failed:', error);
    });
  }, 5000);
})();
