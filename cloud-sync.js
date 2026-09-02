(function () {
  'use strict';

  const USER_DATA_KEYS = [
    'my_finances_data_v11',
    'my_finances_fixed_v11',
    'my_finances_categories_v11',
    'my_finances_calendar_notes_v11'
  ];
  const POLL_INTERVAL_MS = 2000;
  const PUSH_DEBOUNCE_MS = 900;

  let financeCloudClient = null;
  let cloudUser = null;
  let cloudRevision = 0;
  let cloudSyncedFingerprint = '';
  let cloudSyncBusy = false;
  let cloudApplyInProgress = false;
  let cloudPushTimer = null;
  let cloudRealtimeChannel = null;
  let pendingLoginEmail = '';
  let cloudSessionUserId = null;
  let cloudSessionHandling = false;

  function getCloudConfig() {
    return window.FINANCE_SUPABASE_CONFIG || {};
  }

  function isCloudConfigured() {
    const config = getCloudConfig();
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.url || '').trim())
      && (/^sb_publishable_/i.test(String(config.publishableKey || '').trim()) || /^eyJ/.test(String(config.publishableKey || '').trim()));
  }

  function buildSyncState() {
    return {
      schemaVersion: 1,
      transactions: Array.isArray(transactions) ? transactions : [],
      fixedItems: Array.isArray(fixedItems) ? fixedItems : [],
      trash: Array.isArray(trash) ? trash : [],
      categoryOptions: categoryOptions && typeof categoryOptions === 'object' ? categoryOptions : {},
      calendarNotes: Array.isArray(calendarNotes) ? calendarNotes : []
    };
  }

  function stateFingerprint(state = buildSyncState()) {
    return JSON.stringify(state);
  }

  function normaliseRemoteState(state) {
    const safe = state && typeof state === 'object' ? state : {};
    const hasCategoryShape = safe.categoryOptions
      && Array.isArray(safe.categoryOptions?.gasto?.income)
      && Array.isArray(safe.categoryOptions?.gasto?.expense)
      && Array.isArray(safe.categoryOptions?.ahorro?.income)
      && Array.isArray(safe.categoryOptions?.ahorro?.expense);
    return {
      schemaVersion: 1,
      transactions: Array.isArray(safe.transactions) ? safe.transactions : [],
      fixedItems: Array.isArray(safe.fixedItems) ? safe.fixedItems : [],
      trash: Array.isArray(safe.trash) ? safe.trash : [],
      categoryOptions: hasCategoryShape ? safe.categoryOptions : defaultCategories,
      calendarNotes: Array.isArray(safe.calendarNotes) ? safe.calendarNotes : []
    };
  }

  function itemIdentity(item, prefix) {
    if (item?.externalId) return `${prefix}:external:${item.externalId}`;
    if (item?.id) return `${prefix}:id:${item.id}`;
    return `${prefix}:legacy:${item?.timestamp || ''}:${item?.amount || ''}:${item?.concept || item?.name || item?.text || ''}`;
  }

  function mergeLists(remoteList, localList, prefix) {
    const merged = new Map();
    [...remoteList, ...localList].forEach(item => {
      if (!item || typeof item !== 'object') return;
      merged.set(itemIdentity(item, prefix), item);
    });
    return [...merged.values()];
  }

  function mergeCategories(remoteCategories, localCategories) {
    const result = JSON.parse(JSON.stringify(remoteCategories || {}));
    ['gasto', 'ahorro'].forEach(account => {
      if (!result[account]) result[account] = {};
      ['income', 'expense'].forEach(type => {
        const remoteValues = Array.isArray(remoteCategories?.[account]?.[type]) ? remoteCategories[account][type] : [];
        const localValues = Array.isArray(localCategories?.[account]?.[type]) ? localCategories[account][type] : [];
        result[account][type] = [...new Set([...remoteValues, ...localValues])];
      });
    });
    return result;
  }

  function mergeSyncStates(remoteState, localState) {
    const remote = normaliseRemoteState(remoteState);
    const local = normaliseRemoteState(localState);
    const mergedTrash = mergeLists(remote.trash, local.trash, 'trash');
    const deletedIdentities = new Set(mergedTrash.map(item => itemIdentity(item, item.itemType === 'fixed' ? 'fixed' : 'transaction')));
    const mergedTransactions = mergeLists(remote.transactions, local.transactions, 'transaction')
      .filter(item => !deletedIdentities.has(itemIdentity(item, 'transaction')))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    const mergedFixedItems = mergeLists(remote.fixedItems, local.fixedItems, 'fixed')
      .filter(item => !deletedIdentities.has(itemIdentity(item, 'fixed')));

    return {
      schemaVersion: 1,
      transactions: mergedTransactions,
      fixedItems: mergedFixedItems,
      trash: mergedTrash,
      categoryOptions: mergeCategories(remote.categoryOptions, local.categoryOptions),
      calendarNotes: mergeLists(remote.calendarNotes, local.calendarNotes, 'note')
    };
  }

  function applySyncState(rawState) {
    const state = normaliseRemoteState(rawState);
    cloudApplyInProgress = true;
    try {
      transactions = state.transactions;
      fixedItems = state.fixedItems;
      trash = state.trash;
      categoryOptions = state.categoryOptions;
      calendarNotes = state.calendarNotes;

      localStorage.setItem('my_finances_data_v11', JSON.stringify(transactions));
      localStorage.setItem('my_finances_fixed_v11', JSON.stringify(fixedItems));
      localStorage.setItem('my_finances_trash_v11', JSON.stringify(trash));
      localStorage.setItem('my_finances_categories_v11', JSON.stringify(categoryOptions));
      localStorage.setItem('my_finances_calendar_notes_v11', JSON.stringify(calendarNotes));
      cloudSyncedFingerprint = stateFingerprint(state);
      renderAll();
      updateAppBadge();
    } finally {
      setTimeout(() => { cloudApplyInProgress = false; }, 0);
    }
  }

  function setCloudMessage(message, success = false) {
    const element = document.getElementById('cloud-message');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('hidden', !message);
    element.classList.toggle('text-app-pink', !success);
    element.classList.toggle('text-app-mint', success);
  }

  function setCloudBusy(isBusy) {
    cloudSyncBusy = isBusy;
    ['cloud-send-code-button', 'cloud-verify-code-button', 'cloud-sync-now-button'].forEach(id => {
      const button = document.getElementById(id);
      if (!button) return;
      button.disabled = isBusy;
      button.classList.toggle('opacity-60', isBusy);
    });
    if (isBusy) updateCloudStatus('Sincronizando…', 'working');
  }

  function updateCloudStatus(text, state = 'idle') {
    const status = document.getElementById('cloud-sync-status');
    const indicator = document.getElementById('cloud-sync-indicator');
    if (status) status.textContent = text;
    if (!indicator) return;
    const color = state === 'ok' ? 'bg-app-mint' : state === 'error' ? 'bg-app-pink' : state === 'working' ? 'bg-app-purple' : 'bg-gray-300';
    indicator.className = `w-2.5 h-2.5 rounded-full ${color}`;
  }

  function updateCloudAccountUI() {
    const configured = isCloudConfigured();
    const authFlow = document.getElementById('cloud-auth-flow');
    const accountFlow = document.getElementById('cloud-account-flow');
    const configWarning = document.getElementById('cloud-config-required');
    if (!authFlow || !accountFlow || !configWarning) return;

    configWarning.classList.toggle('hidden', configured);
    authFlow.classList.toggle('hidden', !configured || Boolean(cloudUser));
    accountFlow.classList.toggle('hidden', !configured || !cloudUser);
    if (cloudUser) {
      document.getElementById('cloud-account-email').textContent = cloudUser.email || 'Cuenta Supabase';
    }
  }

  function formatSyncDate(value) {
    if (!value) return 'Todavía no sincronizado';
    try {
      return `Última sincronización: ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))}`;
    } catch (_) {
      return 'Sincronización completada';
    }
  }

  async function fetchRemoteSnapshot() {
    const { data, error } = await financeCloudClient
      .from('finance_snapshots')
      .select('state, revision, updated_at')
      .eq('user_id', cloudUser.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function saveSnapshot(state, expectedRevision) {
    const { data, error } = await financeCloudClient.rpc('save_finance_snapshot', {
      p_state: state,
      p_expected_revision: Number(expectedRevision || 0)
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.revision) throw new Error('Supabase no devolvió una revisión válida.');
    cloudRevision = Number(result.revision);
    cloudSyncedFingerprint = stateFingerprint(state);
    const lastSync = document.getElementById('cloud-last-sync');
    if (lastSync) lastSync.textContent = formatSyncDate(result.updated_at || new Date().toISOString());
    updateCloudStatus('Datos sincronizados', 'ok');
    return result;
  }

  async function pushLocalSnapshot(allowConflictMerge = true) {
    if (!cloudUser || cloudApplyInProgress || cloudSyncBusy) return;
    setCloudBusy(true);
    const localState = buildSyncState();
    try {
      await saveSnapshot(localState, cloudRevision);
      setCloudMessage('Datos guardados en Supabase.', true);
    } catch (error) {
      const isConflict = String(error.message || '').toUpperCase().includes('SYNC_CONFLICT');
      if (isConflict && allowConflictMerge) {
        const remote = await fetchRemoteSnapshot();
        const merged = mergeSyncStates(remote?.state, localState);
        cloudRevision = Number(remote?.revision || 0);
        applySyncState(merged);
        setCloudBusy(false);
        return pushLocalSnapshot(false);
      }
      updateCloudStatus('Error de sincronización', 'error');
      setCloudMessage(error.message || 'No se pudo guardar en Supabase.');
    } finally {
      setCloudBusy(false);
    }
  }

  async function pullRemoteSnapshot(showMessage = false) {
    if (!cloudUser || cloudSyncBusy) return;
    setCloudBusy(true);
    try {
      const remote = await fetchRemoteSnapshot();
      if (!remote) {
        cloudRevision = 0;
        setCloudBusy(false);
        await pushLocalSnapshot(false);
        return;
      }
      cloudRevision = Number(remote.revision || 0);
      applySyncState(remote.state);
      const lastSync = document.getElementById('cloud-last-sync');
      if (lastSync) lastSync.textContent = formatSyncDate(remote.updated_at);
      updateCloudStatus('Datos sincronizados', 'ok');
      if (showMessage) setCloudMessage('Datos actualizados desde Supabase.', true);
    } catch (error) {
      updateCloudStatus('Error de sincronización', 'error');
      setCloudMessage(error.message || 'No se pudo descargar la información.');
    } finally {
      setCloudBusy(false);
    }
  }

  async function performInitialCloudSync() {
    if (!cloudUser) return;
    setCloudBusy(true);
    try {
      const remote = await fetchRemoteSnapshot();
      const migrationKey = `finance_cloud_migrated_${cloudUser.id}`;
      const hasStoredLocalData = USER_DATA_KEYS.some(key => localStorage.getItem(key) !== null);
      if (!remote) {
        cloudRevision = 0;
        setCloudBusy(false);
        await pushLocalSnapshot(false);
      } else if (!localStorage.getItem(migrationKey) && hasStoredLocalData) {
        cloudRevision = Number(remote.revision || 0);
        const merged = mergeSyncStates(remote.state, buildSyncState());
        applySyncState(merged);
        setCloudBusy(false);
        await pushLocalSnapshot(true);
      } else {
        cloudRevision = Number(remote.revision || 0);
        applySyncState(remote.state);
        const lastSync = document.getElementById('cloud-last-sync');
        if (lastSync) lastSync.textContent = formatSyncDate(remote.updated_at);
        updateCloudStatus('Datos sincronizados', 'ok');
      }
      localStorage.setItem(migrationKey, '1');
    } catch (error) {
      updateCloudStatus('Error de sincronización', 'error');
      setCloudMessage(error.message || 'No se pudo iniciar la sincronización.');
    } finally {
      setCloudBusy(false);
    }
  }

  function subscribeToCloudChanges() {
    if (!cloudUser || cloudRealtimeChannel) return;
    cloudRealtimeChannel = financeCloudClient
      .channel(`finance-snapshot-${cloudUser.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'finance_snapshots',
        filter: `user_id=eq.${cloudUser.id}`
      }, payload => {
        const incomingRevision = Number(payload.new?.revision || 0);
        if (incomingRevision > cloudRevision && !cloudSyncBusy) {
          pullRemoteSnapshot(false);
        }
      })
      .subscribe();
  }

  function unsubscribeFromCloudChanges() {
    if (!cloudRealtimeChannel || !financeCloudClient) return;
    financeCloudClient.removeChannel(cloudRealtimeChannel);
    cloudRealtimeChannel = null;
  }

  async function handleCloudSession(session) {
    if (cloudSessionHandling) return;
    cloudUser = session?.user || null;
    updateCloudAccountUI();
    if (!cloudUser) {
      cloudSessionUserId = null;
      cloudRevision = 0;
      cloudSyncedFingerprint = '';
      unsubscribeFromCloudChanges();
      updateCloudStatus('Inicia sesión para sincronizar', 'idle');
      return;
    }
    if (cloudSessionUserId === cloudUser.id && cloudSyncedFingerprint) return;
    cloudSessionHandling = true;
    try {
      cloudSessionUserId = cloudUser.id;
      updateCloudStatus('Conectando…', 'working');
      await performInitialCloudSync();
      subscribeToCloudChanges();
    } finally {
      cloudSessionHandling = false;
    }
  }

  async function initializeCloudSync() {
    updateCloudAccountUI();
    if (!isCloudConfigured()) {
      updateCloudStatus('Pendiente de configurar', 'idle');
      return;
    }
    if (!window.supabase?.createClient) {
      updateCloudStatus('Supabase no disponible', 'error');
      return;
    }

    const config = getCloudConfig();
    financeCloudClient = window.supabase.createClient(config.url.trim(), config.publishableKey.trim(), {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    const { data, error } = await financeCloudClient.auth.getSession();
    if (error) {
      updateCloudStatus('Error de acceso', 'error');
      return;
    }
    await handleCloudSession(data.session);
    financeCloudClient.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => handleCloudSession(session), 0);
    });

    setInterval(() => {
      if (!cloudUser || cloudSyncBusy || cloudApplyInProgress) return;
      const fingerprint = stateFingerprint();
      if (fingerprint === cloudSyncedFingerprint) return;
      clearTimeout(cloudPushTimer);
      cloudPushTimer = setTimeout(() => pushLocalSnapshot(true), PUSH_DEBOUNCE_MS);
    }, POLL_INTERVAL_MS);
  }

  window.openCloudSyncModal = function () {
    toggleSidebar(false);
    setCloudMessage('');
    updateCloudAccountUI();
    openModal('modal-cloud-sync');
  };

  window.sendCloudLoginCode = async function () {
    if (!financeCloudClient) { setCloudMessage('Primero configura Supabase.'); return; }
    const email = document.getElementById('cloud-email-input').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { setCloudMessage('Introduce un correo válido.'); return; }
    setCloudBusy(true);
    setCloudMessage('');
    try {
      const { error } = await financeCloudClient.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true }
      });
      if (error) throw error;
      pendingLoginEmail = email;
      document.getElementById('cloud-code-step').classList.remove('hidden');
      document.getElementById('cloud-code-input').focus();
      updateCloudStatus('Código enviado por correo', 'ok');
      setCloudMessage('Revisa tu correo e introduce el código recibido.', true);
    } catch (error) {
      setCloudMessage(error.message || 'No se pudo enviar el código.');
    } finally {
      setCloudBusy(false);
    }
  };

  window.verifyCloudLoginCode = async function () {
    const email = pendingLoginEmail || document.getElementById('cloud-email-input').value.trim().toLowerCase();
    const token = document.getElementById('cloud-code-input').value.replace(/\s/g, '');
    if (!email || !token) { setCloudMessage('Introduce el correo y el código recibido.'); return; }
    setCloudBusy(true);
    try {
      const { data, error } = await financeCloudClient.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
      await handleCloudSession(data.session);
      setCloudMessage('Cuenta conectada y datos sincronizados.', true);
    } catch (error) {
      setCloudMessage(error.message || 'Código incorrecto o caducado.');
    } finally {
      setCloudBusy(false);
    }
  };

  window.syncCloudNow = async function () {
    if (!cloudUser) { setCloudMessage('Inicia sesión primero.'); return; }
    const localFingerprint = stateFingerprint();
    if (localFingerprint !== cloudSyncedFingerprint) await pushLocalSnapshot(true);
    else await pullRemoteSnapshot(true);
  };

  window.signOutCloud = async function () {
    if (!financeCloudClient) return;
    setCloudBusy(true);
    try {
      await financeCloudClient.auth.signOut();
      cloudUser = null;
      cloudSessionUserId = null;
      cloudSyncedFingerprint = '';
      unsubscribeFromCloudChanges();
      updateCloudAccountUI();
      updateCloudStatus('Inicia sesión para sincronizar', 'idle');
      closeModal('modal-cloud-sync');
    } finally {
      setCloudBusy(false);
    }
  };

  window.generateWalletShortcutToken = async function () {
    if (!cloudUser) { setCloudMessage('Inicia sesión primero.'); return; }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = `fin_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
    setCloudBusy(true);
    try {
      const { error } = await financeCloudClient.rpc('set_wallet_ingest_token', { p_token: token });
      if (error) throw error;
      document.getElementById('wallet-token-value').textContent = token;
      document.getElementById('wallet-token-result').classList.remove('hidden');
      setCloudMessage('Clave creada. Al renovarla, la anterior deja de funcionar.', true);
    } catch (error) {
      setCloudMessage(error.message || 'No se pudo crear la clave del atajo.');
    } finally {
      setCloudBusy(false);
    }
  };

  window.copyWalletToken = async function () {
    const token = document.getElementById('wallet-token-value').textContent.trim();
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCloudMessage('Clave copiada.', true);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = token;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      setCloudMessage('Clave copiada.', true);
    }
  };

  window.copyWalletShortcutSetup = async function () {
    const token = document.getElementById('wallet-token-value').textContent.trim();
    const config = getCloudConfig();
    if (!token || !isCloudConfigured()) {
      setCloudMessage('Primero crea la clave del atajo.');
      return;
    }
    const setup = [
      `URL: ${config.url.trim()}/rest/v1/rpc/ingest_wallet_payment`,
      `apikey: ${config.publishableKey.trim()}`,
      'Content-Type: application/json',
      `p_token: ${token}`
    ].join('\n');
    try {
      await navigator.clipboard.writeText(setup);
      setCloudMessage('Datos del atajo copiados.', true);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = setup;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      setCloudMessage('Datos del atajo copiados.', true);
    }
  };

  window.addEventListener('online', () => {
    if (cloudUser && !cloudSyncBusy) pullRemoteSnapshot(false);
  });

  document.addEventListener('DOMContentLoaded', initializeCloudSync);
})();
