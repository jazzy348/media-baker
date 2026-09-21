(function exposeApiClient(global) {
  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body,
      signal: options.signal
    });

    const serverVersion = response.headers.get("X-Media-Baker-Version");
    const serverRevision = response.headers.get("X-Media-Baker-Revision");
    if (serverVersion) {
      global.dispatchEvent(new CustomEvent("media-baker:server-version", {
        detail: { version: serverVersion, revision: serverRevision || serverVersion }
      }));
    }

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async function responseErrorMessage(response) {
    try {
      const data = await response.json();
      if (data && data.error) {
        return String(data.error);
      }
    } catch (err) {
      // The response status below is the useful fallback for non-JSON errors.
    }

    return response.statusText || `Request failed: ${response.status}`;
  }

  global.MediaBakerApi = Object.freeze({ requestJson });
})(window);
