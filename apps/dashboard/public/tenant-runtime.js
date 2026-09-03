(() => {
  const originalFetch = window.fetch.bind(window);
  const ATTENDRA_API = 'https://attendra-api.onrender.com';

  function companyIdFromToken(token) {
    if (!token) return '';
    const parts = String(token).split('.');
    for (const part of parts) {
      try {
        const raw = part.replace(/-/g, '+').replace(/_/g, '/');
        const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        if (payload && payload.companyId) return String(payload.companyId);
      } catch {}
    }
    return '';
  }

  function storedToken() {
    return sessionStorage.getItem('attendra_admin_token') || '';
  }

  function tokenFromInit(init) {
    try {
      const headers = new Headers(init?.headers || {});
      const auth = headers.get('Authorization') || '';
      if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    } catch {}
    return storedToken();
  }

  function isAttendraApi(url) {
    try { return new URL(url, window.location.href).origin === new URL(ATTENDRA_API).origin; }
    catch { return false; }
  }

  window.fetch = function(input, init = {}) {
    try {
      let rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const sessionToken = storedToken();
      const suppliedToken = tokenFromInit(init);
      const token = sessionToken || suppliedToken;
      const companyId = companyIdFromToken(token);

      if (companyId && /\/v1\/companies\/[^/]+\/attendance\//.test(rawUrl)) {
        rawUrl = rawUrl.replace(/\/v1\/companies\/[^/]+\/attendance\//, `/v1/companies/${encodeURIComponent(companyId)}/attendance/`);
      }

      const nextHeaders = new Headers(input instanceof Request ? input.headers : init.headers || {});
      if (token && isAttendraApi(rawUrl)) nextHeaders.set('Authorization', `Bearer ${token}`);

      if (input instanceof Request) {
        input = new Request(rawUrl, input);
        init = { ...init, headers: nextHeaders };
      } else {
        input = rawUrl;
        init = { ...init, headers: nextHeaders };
      }
    } catch {}
    return originalFetch(input, init);
  };

  window.AttendraSession = {
    token: storedToken,
    companyId: () => companyIdFromToken(storedToken())
  };
})();
