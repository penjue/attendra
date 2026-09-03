(() => {
  const originalFetch = window.fetch.bind(window);

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

  function tokenFromInit(init) {
    try {
      const headers = new Headers(init?.headers || {});
      const auth = headers.get('Authorization') || '';
      if (auth.startsWith('Bearer ')) return auth.slice(7);
    } catch {}
    return sessionStorage.getItem('attendra_admin_token') || '';
  }

  window.fetch = function(input, init) {
    try {
      const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const companyId = companyIdFromToken(tokenFromInit(init));
      if (companyId && /\/v1\/companies\/[^/]+\/attendance\//.test(rawUrl)) {
        const nextUrl = rawUrl.replace(/\/v1\/companies\/[^/]+\/attendance\//, `/v1/companies/${encodeURIComponent(companyId)}/attendance/`);
        if (input instanceof Request) input = new Request(nextUrl, input);
        else input = nextUrl;
      }
    } catch {}
    return originalFetch(input, init);
  };
})();
